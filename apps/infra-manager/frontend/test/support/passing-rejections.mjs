/**
 * A dev-server middleware that hands a rejection to next(), which answers it with a 500. Without it the
 * request stays open until the page gives up and the rejection goes unhandled, far from its cause.
 */
export function passingRejections(handle) {
  return (req, res, next) => {
    handle(req, res, next).catch(next);
  };
}
