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
`--margin` needs `--format` — is the render's, and a check of
an existing PDF has no HTML. Handing them the same tokens
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

A flag may carry its value with an equals sign, `--format=a4` as well as
`--format a4`, and only the first equals sign is the separator.

The parser and the two ways of saying something -- a usage error and a
formatted size -- live in their own small module, so the parser does not have
to reach the entry point to raise an error. It used to, and the entry point
reaches the renderer, so importing the parser loaded the renderer with it:
78 milliseconds before, 20 after.

The version in the header is the transport's claim and the version in the
body is the message's, and the reply follows the era of the request. A client
that says the modern revision in the header and leaves it out of the body is
making a modern request, and a modern request has to carry its capabilities:
it is told so rather than answered in a shape it did not ask for. The same
error code reports the same list of versions whichever way it is caught.

A batch is a batch on both transports. The session handler has always
answered one, and the http route refused it, so the two transports disagreed
about the same message.

A custom parameter header with no counterpart in the body is a disagreement,
whether the body carries arguments or not.

The two subcommands take the flags that make sense for them and refuse the
others, because a flag a subcommand ignores is a flag the reader believes was
used. `letterpress page` takes `--format` and `--margin`; `letterpress
validate` takes none but `--json` and `--quiet`; both have their own `--help`.

`letterpress page` says what `--landscape` would do to a document, in one
line. There are four cases, and the first two are the ones a single boolean
gets wrong. `transposePageSize` returns null for both a document that
declares no paper and one that declares `size: auto`, and they are
opposites: with no declaration the flag goes straight to the print engine and
works, while `size: auto` is refused with an error finding and the sheet
stays portrait. Reporting the second reason for the first is how a correct
flag gets called broken.

## The tools an agent gets

Four, and the number is the point: a tool's name, description and schema all
go into the model's context, and a catalogue of twenty is worse than three
that are clear. The model spends its attention choosing, and a wrong choice
costs more than a missing tool.

`render_html` prints HTML to PDF and reports what the document got wrong. It
also takes a `probe`: `gaps` names the element behind a wide gap and the CSS
that caused it, and `fonts` says which families the document asked for. A
finding says a gap is too wide; the probe says which one and why.

`validate_pdf` checks a PDF that already exists, by path or by sending the
bytes. It reads the file and nothing else, so it costs milliseconds against the
~1s a render takes.

The bytes may be sent as base64, and a string that is not base64 is refused
rather than decoded. The decoder is forgiving: it drops the characters it does
not recognise and carries on, so a string that is not base64 at all decodes to
something, and the answer to a request for a pdf becomes a complaint about the
pdf.

The paper names are the renderer's own, and a name is read the way the command
line reads it: `A4` and `a4` are the same paper. The list is served to the
viewer page with the findings, so the page and the server cannot disagree
about which papers exist.

`page_rules` says what the renderer would make of a document's own `@page`
rules: the paper and margin it declares, what `--landscape` would do to them,
and what `--format` and `--margin` would change. The question is worth
asking before a render, and a render does not answer it on its own.

`list_findings` returns every code with its severity and what it means, so
the codes in a result can be read.

## One set of page ranges, three ways in

The command line, the http endpoint and the model context protocol all take
`--page-ranges`, so they all ask the same question about it: is this a page
number or a range of them, and does a range start before it ends. A range
that starts after it ends is refused, rather than handed to chromium, which
answers "Page range is invalid (start > end)" and turns a client's mistake
into a failure of the server.

## The rules a shared server puts on a caller

The stdio server answers to whoever started it. That caller can already read
every file the process can read and write every file it can write, so giving
it the whole filesystem changes nothing.

The HTTP server is a shared daemon: any local process can reach it. A path it
accepts is a file-read primitive for all of them, a document count it does not
bound is a way to exhaust the browser, and a render it does not queue is a way
to saturate it. So the HTTP server passes a sandbox, and every limit the
render endpoint already enforces is in it:

- the only directory a caller may read from or write to;
- the most pages a document may have;
- the most the caller may ask the renderer to wait;
- a slot in the render queue.

The rules are one object rather than a set of optional fields, because an
optional field is a security property that is off by default and invisible in
the type: a caller that forgets to set it gets no confinement and no error.

A directory to read the document's assets from is refused, the way a path
is. It is a way of naming files for the server to read, and to have read in
the page, and the server is a shared daemon. The endpoint that renders takes
no path and no directory, and the tools on the same route take neither.

The documents a server has written are kept for an hour and swept after
that, rather than swept as they are superseded. One caller of a shared
server was told a path, and another caller's render must not delete it.

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
and `HeaderMismatch`, which is the code the spec allocates for it. A version
this server does not speak is refused with `UnsupportedProtocolVersion`,
which lists the versions it does.

The custom `Mcp-Param-{Name}` headers are checked the same way: the spec lets
a tool mark a parameter to be mirrored into a header, and says the server must
refuse a request whose mirrored header does not match the value in the body.

A header value the spec allows to be base64 is decoded before it is compared.
The sentinel marks a value that cannot be a plain header value, and the spec
says a client must encode one that would otherwise be ambiguous. A value that
matches the sentinel is itself encoded, so the marker is never confused with
the text it wraps.

The version is taken from the header when there is one, because that is what
an intermediary can route on, and from the body otherwise, for a client that
sends neither.

The server keeps the document it was given and sweeps the ones before it, so a
server that renders all afternoon does not fill the disk with documents nobody
asked for.

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
which accepts no path at all. A caller that holds a file of its own sends the
bytes instead, as base64, which grants nothing: the server parses what it was
given and answers.

The check resolves the path, so `../` cannot get out and neither can a
symbolic link whose target is elsewhere. A link is followed by hand rather
than by `realpathSync`, because the file the link points at usually does not
exist yet — the PDF is about to be written there — and `realpathSync` fails
on a broken link, which would have left the link itself as the answer and
missed the escape entirely.

## The routes the server answers

One function per route. The dispatcher is a list of paths and the checks that
come before any of them: the host and the origin, refused before the body is
read, so a request from another web page is turned away without its bytes
being taken in.

The dispatcher was one function of two hundred and forty lines of code, and a
reader could not see where one route ended and the next began. It is fifty-one
now, and it is no longer on the complexity list.

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
