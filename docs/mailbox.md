# Mailbox

The Mailbox connector gives a Bot one mailbox: it can list what has arrived, open a message, search
for one, and send mail, including a threaded reply. "Check the support mailbox and tell me what came
in overnight" is a mailbox question, and so is "reply to Dana and say we will have it by Friday."

There is exactly one mailbox and it belongs to the deployment. It is not the mailbox of whoever is
asking, and no person connects an account to it. That is the difference from Google Drive or Notion,
where each person consents for themselves and sees only their own; here everybody granted the tools
reads the same mail. Decide that before granting it, because it is the whole of the access model.

## The prerequisite

Two things, and both are an administrator's:

1. **Configuration**, which says where the mailbox is (below).
2. **Grants**, which say which Bots may use it. Mailbox is a catalogue entry like any other, at
   `/admin/plugins/mailbox`, and enabling the entry hands no Bot anything. Each of the four tools is
   granted per Bot, so "may read the mail" and "may answer it" are two separate decisions.

`send_message` is the connector's only write tool, and it is a write in the strongest sense this
product has: it reaches people who never agreed to talk to a Bot, and there is nothing to recall once
it has run. Grant it deliberately, and consider a policy rule that requires approval for it the same
way one would for any other irreversible action.

## Configuration

| Variable             | Default | What it is                                                        |
| -------------------- | ------- | ----------------------------------------------------------------- |
| `MAILBOX_IMAP_HOST`  | unset   | The IMAP server messages are read from.                           |
| `MAILBOX_SMTP_HOST`  | unset   | The SMTP server mail is sent through.                             |
| `MAILBOX_USER`       | unset   | The account both protocols sign in as, and what mail is sent from. |
| `MAILBOX_IMAP_PORT`  | `993`   | Implicit TLS. Set only for a server that listens elsewhere.        |
| `MAILBOX_SMTP_PORT`  | `465`   | Implicit TLS. Set only for a server that listens elsewhere.        |
| `MAILBOX_ALLOWED_RECIPIENT_DOMAINS` | unset (anywhere) | Comma-separated domains a Bot may send to. See [Bounding where mail can go](#bounding-where-mail-can-go). |

The three hosts-and-user variables are needed together. Set one or two and the server refuses to
start, naming the ones that are missing, rather than booting with half a mailbox that fails at the
first login, at run time, in front of somebody, with nothing but an authentication error from a
server that will not say which half was wrong. Leave all three unset and the connector is still
listed, still grantable, and every tool call answers with the sentence naming what to set.

Both ports default to the implicit-TLS ones rather than the STARTTLS ones, so the connection is
encrypted before the password is sent rather than negotiating for it in the clear.

### The password is not an environment variable

It is the only secret in this feature, so it lives where this deployment's other secrets live: the
encrypted credential vault. Store it at `/admin/credentials` as:

- **kind** `mcp`, the vault's name for "the one token this deployment holds for this server", which
  is exactly what a mailbox password is: one secret, the deployment's, used for every Bot granted the
  tools, never anybody's own grant.
- **provider** `mailbox`
- **key id** `mailbox`

Rotate it in the same place. The password is read from the vault at the moment a call needs it and
thrown away after, so a rotation takes effect on the next tool call rather than on the next restart,
and revoking it stops the tools within a call.

Nothing prints it. IMAP logging is off at the client, which matters because one of the commands it
would log is the authentication one; and a failure sentence from a mail server that quoted the login
back is scrubbed before it reaches an audit row, a transcript or a model. The scrub covers the
base64 forms as well as the plaintext, because neither client sends the password as typed: IMAP
authenticates with `AUTH=PLAIN` or `AUTH=LOGIN`, both base64 on the wire, so a quoted command
carries an encoding of it rather than the password itself.

## The four tools

- **`list_messages`**: the newest messages in a mailbox, newest first: uid, date, sender, subject
  and whether it has been read. No bodies. `limit` defaults to 10 and is capped at 50; `mailbox`
  defaults to `INBOX`.
- **`read_message`**: one message by `uid`, with its headers and its text.
- **`search_messages`**: messages whose subject, sender or text match `query`, newest first.
  `limit` defaults to 20. The match is the mail server's own IMAP `SEARCH`: a plain substring, with
  no ranking and no boolean syntax.
- **`send_message`**: sends `to`, `subject` and `body` from the deployment's mailbox. Give
  `in_reply_to` as the uid of a message and the reply threads: the original is fetched, its
  `Message-ID` becomes `In-Reply-To`, its own `References` chain plus that id becomes `References`,
  and `Re: ` goes in front of the subject if it is not already there. Without it, the message opens a
  new thread however the subject is worded.

The sender is always `MAILBOX_USER`. There is no field for it, so a Bot cannot send as somebody else.

**Uids are per mailbox.** A uid from a listing of `Archive` names a different message in `INBOX`, so
every tool that takes one also takes the `mailbox` it came from. A uid that is not there is refused
by name rather than guessed at, and for `send_message` nothing is sent.

**Every result is bounded.** At most 512 KB of a message is read off the wire, so one mail with a
large attachment cannot become a gigabyte in this process; a message body is then cut at 8,000
characters and says so, with the full length, so a model can tell a message that has said what it
came to say from one that has not; and the whole result is capped again at the same 20,000
characters every other connector's is. A listing or a search that had more behind it says
"showing 10 of 4321" rather than presenting a page as the whole mailbox. Truncation is always
visible, never silent.

**Every call has a deadline.** Sixty seconds of wall clock per network operation, on top of the
thirty-second inactivity timeouts, and the socket is closed when it expires. The inactivity timeouts
alone would let a server that drips one byte at a time hold a turn open forever.

**Nothing is changed by reading.** Opening a message does not mark it read, move it or delete it, and
there is no tool that does. A connection is opened, used and closed per call; no session is kept.

## Bounding where mail can go

`MAILBOX_ALLOWED_RECIPIENT_DOMAINS` is a comma-separated list of domains (`example.com,partner.example`;
a leading `@` is accepted and dropped). Set it and `send_message` refuses any recipient outside the
list before it opens a connection, naming the domain that was refused and saying nothing was sent.
Unset or empty means anywhere, so a deployment that has not set it behaves exactly as before.

**Why this exists rather than a policy rule.** The policy engine sees a tool call's name and its
effect. It does not see the arguments, so no rule can say "may email the company and nobody else":
the only thing a rule can express about `send_message` is whether it happens at all. That leaves a
deployment two controls, and they do different jobs:

1. **An approval rule on `send_message`** in your boundaries. Wholesale, per send, with a person in
   the loop. This is the control that decides whether mail goes out.
2. **This allowlist.** Bounds where anything can go, with nobody in the loop.

**The shape worth protecting against.** The read tools pull text that somebody else wrote into a
model's context, and that text can contain instructions. A Bot holding the read tools and an
unconstrained `send_message` can therefore be talked into mailing the mailbox out, by an email
addressed to it, with no person involved at any point. That is why `send_message` should be
approval-gated wherever the mailbox holds anything worth keeping, and why the allowlist is worth
setting even when it is gated: it is the half that still holds if a rule is edited or a mode is
switched to dry-run.

## Governance

Nothing about a Mailbox tool call is special. It goes through `plugins/store.ts` like every other
connector: the Bot's grant is checked, the policy is evaluated with the tool's effect (`send_message`
as a write, the other three as reads), an audit row is written, and only then is any mail server
dialled. There is no second path to the mailbox and no bypass.

The audit trail records every call, and for a failure it keeps the mail server's own sentence, which
is usually the most useful thing available: "Invalid credentials", "Mailbox does not exist" and
"Relay access denied" each name a different fix.

## See also

- [Configuration](configuration.md): every environment variable, in one table.
- [Architecture](architecture.md): where a plugin call is decided, recorded and made.
- [Routines](routines.md): the other first-party connector that runs in-process, and the one to read
  next if you want a Bot to check the mailbox on a schedule.
