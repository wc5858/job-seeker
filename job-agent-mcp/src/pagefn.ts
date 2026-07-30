/**
 * Running our own code inside the page, safely.
 *
 * We run under tsx, and esbuild's keep-names transform rewrites every nested
 * function into `__name(fn, "fn")`. That helper lives in the Node module scope,
 * not in the page, so handing a function with inner helpers straight to
 * `page.evaluate` dies with `ReferenceError: __name is not defined` — in
 * production, not only in tests. Every in-page function in this project must go
 * through `evalInPage`, which ships the source inside a closure that declares
 * its own `__name`.
 *
 * Evaluating a string is CSP-safe here: Playwright evaluates through CDP, which
 * the page's `script-src` does not gate. That matters — LinkedIn forbids `eval`,
 * so calling `new Function` *inside* the page would be blocked.
 *
 * The argument is passed by JSON, so it must be plain serializable data.
 */
import type { Page } from "playwright";

export async function evalInPage<R, A>(page: Page, fn: (arg: A) => R, arg: A): Promise<R> {
  const expression = `(function (a) {
    var __name = function (f) { return f; };
    return (${fn.toString()})(a);
  })(${JSON.stringify(arg)})`;
  return page.evaluate<R>(expression);
}
