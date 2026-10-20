# The command line, the server, and the checks

The surfaces a caller meets: the flags, the HTTP API, the two commands that do
not render, and what `validate` looks for. The modules are `src/args.ts`
(parsing), `src/cli.ts` (the render command), `src/subcommands.ts` (`validate`
and `page`), `src/server.ts` (the HTTP API) and `src/validate.ts` (the
checks).

## Parsing

The token loop is separate from the rules about what the command as a whole
must look like. `validate` and `page` take the same flags and mean the same
things by them, but the rules `finish` enforces — one input, `--data` needs
`--template`, `--margin` needs `--format` — are the render's, and a check of
an existing PDF has no template and no HTML. Handing them the same tokens
without the same verdicts is the point; copying the loop to get it was 15
duplicated lines that would have drifted the first time a flag was added.

`--page-ranges` is checked here rather than left to fail inside the engine.
Chromium's `printToPDF` takes the string and validates it itself, but the
error arrives as a rejected protocol call several hundred milliseconds into a
render, after a browser has been launched, and reads as a transport failure.
The grammar is small and it is stated in the message either way.

`--probe <name>` is chosen from the probes that exist rather than written by
the caller. A raw-JS flag would be a remote code execution surface on a tool
that renders whatever it is handed, and it would be useless anyway: the
expression runs in the page, where nothing from this module exists, so
`--probe "document.title"` works and `--probe "wideGaps()"` is a
ReferenceError. The functions are named here, shipped by
`Function.prototype.toString`, and can only be invoked the way they were
written to be.

`--auth` takes `user:password`. A colon is required so a typo does not
silently become a username with an empty password. The password may itself
contain colons, so only the first colon separates. The value is also read
from `LETTERPRESS_AUTH`, so a secret need not be on the command line where
`ps` can read it.

## The commands that do not render

`letterpress` renders, and that is the thing it is for. `validate` checks a
file that already exists and `page` explains what the tool made of its
`@page` rules before it ever printed anything. Both run without a browser,
which is the whole reason they are separate commands rather than flags on the
render path.

`letterpress page` says what `--landscape` would do to a document, in one
line. There are four cases, and the first two are the ones a single boolean
gets wrong. `transposePageSize` returns null for both a document that
declares no paper and one that declares `size: auto`, and they are
opposites: with no declaration the flag goes straight to the print engine and
works, while `size: auto` is refused with an error finding and the sheet
stays portrait. Reporting the second reason for the first is how a correct
flag gets called broken.

## The model context protocol over HTTP

The server answers the model context protocol on `/mcp`, the same tools the
stdio server offers, for an agent that cannot start a subprocess -- one on
another machine, or one that speaks HTTP and nothing else.

The spec's Streamable HTTP transport, in the shape the current revision
defines: one endpoint, every JSON-RPC message its own POST, and the answer as
a single JSON object. A notification is answered with 202 and no body.

The headers are not decoration. `MCP-Protocol-Version` has to agree with the
version in the body, and `Mcp-Method` and `Mcp-Name` have to agree with the
body, because an intermediary may route on one and the server may act on the
other. A request whose headers disagree with its body is refused with `400`
and `HeaderMismatch`, which is the code the spec allocates for it.

The origin check is the one this server already applies to every request: a
local MCP endpoint that answers requests from any web page is a remote code
execution surface, and the spec says the same about it.

The version header is only required once the body carries a version, which is
what tells a modern request from a legacy one: a legacy request has no
`_meta` at all, so there is nothing for the header to disagree with.

The tools render in the browser the server already owns, and in the queue
around it, so an MCP call arriving over HTTP renders in the same browser as an
HTTP render rather than launching a second one. The PDF lands in a work
directory the server removes when it stops.

Where the PDF may be written differs by transport, and the difference is a
privilege one. The stdio server answers to whoever started it, and that
caller can already write wherever it likes, so it is given the whole
filesystem. The HTTP server is a shared daemon: any local process can reach
it, so a path it accepts becomes a file-write primitive for all of them. Over
HTTP the PDF therefore lands in the server's own work directory and nowhere
else, and a path outside it is refused rather than corrected — a caller that
asked for `/etc/passwd` and was handed a file in a temporary directory would
think it had what it asked for.

Reading a file is the same privilege as writing one, so `validate_pdf` is
confined the same way — and it agrees with the server's own render endpoint,
which accepts no path at all.

The check resolves the path, so `../` cannot get out and neither can a
symbolic link whose target is elsewhere. A link is followed by hand rather
than by `realpathSync`, because the file the link points at usually does not
exist yet — the PDF is about to be written there — and `realpathSync` fails
on a broken link, which would have left the link itself as the answer and
missed the escape entirely.

## The HTTP API

A limit from the environment, or the default when it is absent or unusable.
`Number('abc')` is NaN, and every comparison against NaN is false. So a typo
did not disable one limit loudly — it disabled it silently: `active < NaN` is
never true, the queue grew without bound, and neither the 429 nor the
page-limit message ever appeared. The page limit was the worst, because the
413 body still quoted "the 6000-page limit" while no such limit was being
enforced.

Every field check on a render body runs in a fixed order, and the first
failure wins. The order is load-bearing: tests assert specific errors for
bodies wrong in several ways at once. One function per field group keeps each
under the complexity ratchet.

The PDF-byte response carries the report in headers because the body cannot.
The status stays 200 for error findings — the PDF is real and was asked for;
`x-letterpress-errors` is how a client tells a clean render from a failed one.

## Checking a PDF that already exists

Rendering answers "did this produce the document you wrote". `validate` answers
the question after the fact, about bytes on disk that may have come from
anywhere: a file another tool wrote, a file that has been through an editor, a
file downloaded from somewhere and never looked at. Every check reads the file
and nothing else — no browser, no network, no rendering — so it costs
milliseconds against the ~1s a render takes, which is the whole point of
running it separately.

The checks are the same ones a render already runs on its own output, applied
to a file that did not come from this tool. That is deliberate: a finding means
the same thing whether the bytes were just produced or arrived by download, so
there is one vocabulary and not two.

Everything readable about a PDF comes back as findings, ordered so the refusals
come first: an encrypted file cannot be inspected at all, and a file that is
not a PDF cannot be either. Saying "untagged" about an encrypted file would
be true and useless.

## The marked-content census

A marked-content id, and where it was seen. `present` ids are in a page's
content stream; `named` ids are named by the structure tree. The two sets
should be equal, and when they are not the mismatch is a navigation failure
rather than a cosmetic one.

The ids are read out of the file from both ends. The content stream is where
the text actually is; the structure tree is how a reader gets to it. A reader
navigates by walking the tree and asking each element for the content its
`/MCID` names, so an id in only one of the two is unreachable by construction
— from one side the content has no structure, from the other the structure
points at nothing.

A page's content stream is inflated when it is flate. `node:zlib` is a
builtin, so this costs the same nothing as the render's own use of it. A
stream that will not inflate yields nothing rather than throwing: a file can
carry a damaged stream, and the checks here are about what can be read, not
about repairing what cannot.

An uncompressed content stream is legal, and `inflatedStream` inflates
unconditionally: given plain bytes it throws inside and hands back nothing, so
every marked content block in the file read as absent and each tagged file
reported all of its structure as pointing at nothing. Measured on fixtures
built with plain streams before the check for it was here.

What the structure tree and the page streams say about each other is a
navigation failure rather than a rendering one: the page looks right, and a
reader using headings and figures cannot reach parts of it.

## Template values in CSS

A value for a bare CSS slot — `--accent: {{accent}}`, `size: {{paper}}` —
needs more than HTML escaping and more than CSS escaping. Neither escapes a
semicolon or a closing brace, so a JSON value could end the declaration and
open a rule of its own: an invoice whose `accent` was

```
red; } body { display: none } :root { --accent: red
```

printed with no body at all, one page, exit 0, and no finding. Escaping only
what a _string_ needs to be safe leaves the value free to leave the
declaration.

Everything outside the set a CSS value legitimately uses is backslash-escaped,
which is what makes `;` `{` `}` `:` `"` `'` `<` `>` `@` inert. Inside a
comment this is noise, but the invoice template already carries several and a
backslash inside one cannot terminate the following rule.
