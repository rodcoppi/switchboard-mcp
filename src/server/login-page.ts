// The login page, served as one self-contained document.
//
// No stylesheet, no script file, no font, no favicon: while the gate is armed
// every one of those would itself be a 401, and a login page that cannot load
// its own assets is a login page that looks broken. Everything is inline.

/**
 * Where to go after a successful login.
 *
 * Two separate dangers live in this one string, and both are handled HERE
 * rather than at the call sites:
 *
 *  - **Open redirect.** The value arrives from the URL. `//evil.example` and
 *    `https://evil.example` are both valid targets for `location =`, which
 *    would turn our login page into somebody else's landing page. Only a
 *    single-slash, same-origin path survives.
 *  - **XSS.** It is interpolated into HTML, so it is escaped as well. A path
 *    that passed the first check can still contain a quote.
 */
export function safeNext(next: unknown): string {
  if (typeof next !== "string" || next === "") return "/";
  if (!next.startsWith("/")) return "/";
  // "//host" and "/\host" are protocol-relative URLs, not local paths.
  if (next.startsWith("//") || next.startsWith("/\\")) return "/";
  if (next.startsWith("/login")) return "/";
  return next;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function loginPage(options: { next?: unknown } = {}): string {
  const next = escapeHtml(safeNext(options.next));
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
<meta name="robots" content="noindex, nofollow" />
<title>Switchboard — sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; min-height: 100dvh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    background: #09090b;
    color: #f4f4f5;
    font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  }
  .card {
    width: 100%; max-width: 360px;
    border: 1px solid #27272a; border-radius: 12px;
    background: #111113;
    padding: 26px 22px 22px;
  }
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 4px; }
  .jack { color: #f5a623; font-size: 17px; }
  .wordmark { font-size: 14px; letter-spacing: 3px; font-weight: 600; }
  .sub {
    font-family: ui-sans-serif, system-ui, sans-serif;
    font-size: 12.5px; color: #a1a1aa; line-height: 1.5; margin: 10px 0 18px;
  }
  label { display: block; font-size: 10px; letter-spacing: 1.4px; text-transform: uppercase; color: #a1a1aa; margin-bottom: 7px; }
  input {
    width: 100%; padding: 11px 12px; min-height: 44px;
    background: #09090b; color: #f4f4f5;
    border: 1px solid #27272a; border-radius: 8px;
    font-family: inherit; font-size: 14px;
  }
  input:focus { outline: none; border-color: #f5a623; }
  button {
    width: 100%; margin-top: 14px; padding: 12px; min-height: 44px;
    background: #f5a623; color: #18181b;
    border: none; border-radius: 8px;
    font-family: inherit; font-size: 13px; font-weight: 700;
    cursor: pointer;
  }
  button:disabled { opacity: 0.55; cursor: default; }
  .err {
    margin-top: 13px; padding: 9px 11px;
    border-left: 2px solid #f87171; border-radius: 4px;
    background: rgba(248, 113, 113, 0.08);
    color: #fca5a5;
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; line-height: 1.45;
  }
  .err[hidden] { display: none; }
  .foot {
    margin-top: 18px; padding-top: 14px; border-top: 1px solid #1f1f23;
    font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; color: #71717a; line-height: 1.5;
  }
</style>
</head>
<body>
  <main class="card">
    <div class="brand"><span class="jack">&#8646;</span><span class="wordmark">SWITCHBOARD</span></div>
    <p class="sub">Remote access is on. This board can send messages to agents that run commands on the host machine, so it asks for the password first.</p>
    <form id="f" autocomplete="on">
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password"
             autofocus required inputmode="text" />
      <button id="b" type="submit">Sign in</button>
    </form>
    <div class="err" id="e" role="alert" hidden></div>
    <p class="foot">Set or change it on the host with <code>switchboard remote password</code>. Turn all of this off with <code>switchboard remote off</code>.</p>
  </main>
<script>
(function () {
  var form = document.getElementById("f");
  var input = document.getElementById("p");
  var button = document.getElementById("b");
  var err = document.getElementById("e");
  var next = "${next}";

  function fail(message) {
    err.textContent = message;
    err.hidden = false;
    button.disabled = false;
    button.textContent = "Sign in";
    input.select();
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    err.hidden = true;
    button.disabled = true;
    button.textContent = "Checking…";
    fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: input.value }),
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (body) {
          return { ok: res.ok, body: body };
        });
      })
      .then(function (r) {
        if (r.ok && r.body && r.body.ok) {
          window.location.replace(next);
          return;
        }
        fail((r.body && r.body.error) || "Sign-in failed.");
      })
      .catch(function () {
        fail("Could not reach the hub. Is the tunnel still up?");
      });
  });
})();
</script>
</body>
</html>
`;
}
