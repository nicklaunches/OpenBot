/**
 * The one filter that keeps a broken conversation from being replayed at a model provider for ever.
 *
 * IT LIVES HERE BECAUSE BOTH TURN PATHS NEED IT. A routine's headless turn seeds history itself
 * (`routines/run-turn.ts`) and a chat turn is handed history by the browser (`copilot.ts`). Both
 * hand that history to a `BuiltInAgent`, which converts it and lets the model provider validate the
 * call/result pairing. `run-turn.ts` imports `../copilot`, so this cannot live in either of them
 * without one importing the other back.
 */
import type { Message, ToolCall } from "@ag-ui/client";

/** Whether a message said nothing at all — no text, no parts, nothing to show a person. */
function isSilent(message: Message): boolean {
  const content = (message as { content?: unknown }).content;
  if (content === undefined || content === null) return true;
  if (typeof content === "string") return content.length === 0;
  if (Array.isArray(content)) return content.length === 0;
  return false;
}

/**
 * Refuse to re-present a conversation the model API will reject.
 *
 * FOUND IN PRODUCTION, TWICE, ON BOTH PATHS. First on routines: two firings of one routine, fifteen
 * minutes apart, both failed with `Tool result is missing for tool call
 * call_TTbiXzJVNifQt8ioU1JJmj4S.` — the SAME call id both times, so it did not come from the live
 * turn: the channel's Intelligence thread held an assistant message carrying a tool call whose
 * result message never landed, because an earlier CHAT turn was interrupted mid-call. Then on chat
 * itself: `AI_MissingToolResultsError: Tool result is missing for tool call
 * chatcmpl-tool-8dd56dc7497c5ea9`, thrown three times in a row on one person's next three attempts
 * to say anything. There the damaged message was not even durable: a frontend tool handler was torn
 * down mid-run, so the live agent's messages in the browser held the call, the store did not, and
 * every retry sent the same unanswerable call back up as `input.messages`.
 *
 * A model provider validates call/result pairing, so one historical dangle poisons EVERY later turn
 * that replays it: on routines until the fatigue rule disables the routine, and on chat until the
 * person works out for themselves that the conversation is dead and starts another one. A permanent
 * failure grown out of transient damage, and nothing the person did wrong.
 *
 * WHY DROPPING IS THE RIGHT ANSWER, and not repair. History here is CONTEXT for a turn, not a
 * transaction to resume. A dangling call is already permanently unanswerable — the tool run that
 * would have answered it ended when that turn did, and there is no result to invent. The only two
 * options are to seed a conversation the API refuses, or to seed the same conversation minus a call
 * that never completed. The second one loses a fragment of an interrupted exchange; the first one
 * takes the conversation away.
 *
 * WHAT THIS DOES NOT DO. It does not DELETE anything from the platform. The thread still holds every
 * row and the person still sees the interrupted exchange in their channel. This is a read-side
 * filter on one turn's input and nothing more.
 *
 * IDS ARE NEVER CHANGED, which is what keeps `persistedInputMessages`' id-subtraction in
 * `run-turn.ts` correct: a message this pass stripped a tool call from keeps its id and is still
 * subtracted out as historic, and a message it dropped was never a candidate to persist. So
 * sanitizing cannot turn a firing into one that re-persists the transcript.
 *
 * The rules, in order:
 *  1. A tool call is ANSWERED if some later message carries it as `toolCallId`, or if the caller
 *     says it is answered elsewhere. Later, not merely present: a result ahead of its call is not a
 *     pairing any provider accepts either.
 *  2. An assistant message keeps only its answered calls. If that leaves it with no calls and
 *     nothing said, the message is dropped — an empty assistant husk is itself invalid for some
 *     providers, so stripping the call is not enough.
 *  3. A tool result whose `toolCallId` matches no surviving call is dropped: the mirror-image dangle,
 *     which is what an interruption between the two rows leaves behind in the other order.
 *
 * Order is preserved, the input array is not mutated, and a message the pass does not change is
 * returned as the same object — a healthy thread, which is nearly all of them, goes through
 * untouched rather than through a re-normalization that could quietly differ.
 *
 * @param answeredElsewhere Call ids that are about to be answered by something this history cannot
 * see, and so must survive. That is the interrupt resume: `BuiltInAgent.run` appends a tool result
 * per `input.resume` entry, keyed by `interruptId`, AFTER converting the messages
 * (`@copilotkit/runtime/dist/agent/index.mjs`, the `resumeEntries` block in `run`). Dropping the
 * call that the resume answers would turn a resumable interrupt into an orphaned result, which is
 * the same error seen from the other side.
 */
export function sanitizeSeededHistory(
  history: Message[],
  answeredElsewhere: ReadonlySet<string> = new Set(),
): Message[] {
  /** Every position that answers a call id, in order. */
  const answersFor = new Map<string, number[]>();
  for (const [index, message] of history.entries()) {
    const { toolCallId } = message as { toolCallId?: string };
    if (toolCallId === undefined) continue;
    answersFor.set(toolCallId, [...(answersFor.get(toolCallId) ?? []), index]);
  }
  /*
   * Where a call's answer may still land: before the next thing a person or the system said.
   *
   * The model API walks the conversation in order and refuses it the moment a user or system
   * message arrives while a call is still unanswered. So a result that turns up after a later
   * user message does not answer anything, however real it was. This happened live: a browser
   * tool handler resolved late, its result was appended after the person had already typed the
   * next message, and the call read as answered here while the API still threw on every retry.
   */
  const boundaryAfter: number[] = new Array(history.length).fill(history.length);
  for (let index = history.length - 1, next = history.length; index >= 0; index -= 1) {
    boundaryAfter[index] = next;
    const { role } = history[index] as { role?: string };
    if (role === "user" || role === "system" || role === "developer") next = index;
  }
  const answeredWithin = (id: string, index: number): boolean =>
    (answersFor.get(id) ?? []).some(
      (at) => at > index && at < (boundaryAfter[index] ?? history.length),
    );

  const surviving = new Set<string>();
  const kept: (Message | undefined)[] = history.map((message, index) => {
    const { toolCalls } = message as { toolCalls?: ToolCall[] };
    if (toolCalls === undefined) return message;

    const answered = toolCalls.filter((call) => {
      if (answeredElsewhere.has(call.id)) return true;
      return answeredWithin(call.id, index);
    });
    for (const call of answered) surviving.add(call.id);

    // The husk check goes FIRST so it also catches a row that arrived with no calls and nothing
    // said — the same invalid shape, reached without a dangle.
    if (answered.length === 0 && isSilent(message)) return undefined;
    // The healthy path, and the only one that returns the very same object.
    if (answered.length === toolCalls.length) return message;

    /*
     * Cast for the same reason `toAgentMessage` casts: `Message` is a union discriminated on `role`,
     * and a spread over the union widens past every branch of it. Neither rewrite here can change
     * the role or the shape — one narrows the `toolCalls` array, the other removes the key — so
     * there is nothing to narrow against and nothing that could stop being a `Message`.
     */
    if (answered.length > 0) {
      return { ...message, toolCalls: answered } as Message;
    }
    // Text it did say, minus a call it cannot complete.
    const { toolCalls: _dropped, ...rest } = message as Message & {
      toolCalls?: ToolCall[];
    };
    return rest as Message;
  });

  return kept.filter((message): message is Message => {
    if (message === undefined) return false;
    const { toolCallId } = message as { toolCallId?: string };
    return toolCallId === undefined || surviving.has(toolCallId);
  });
}
