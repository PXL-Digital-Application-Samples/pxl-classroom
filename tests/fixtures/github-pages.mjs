// GitHub's list pagination, for fakes.
//
// A fake list endpoint that ignores `per_page` and `page` returns everything on
// every call, which is kinder than GitHub: the real one answers the first 30
// when `per_page` is absent, so a caller that reads one page looks correct
// against the fake and misses whatever is on page two in production. That is
// how the organization ruleset lookup read only the first 30. A fake serving a
// list that can outgrow a page serves it through `pageOf`.

export const DEFAULT_PER_PAGE = 30;
export const MAX_PER_PAGE = 100;

/** `/a/b?x=1` -> `{ pathname: "/a/b", params }` */
export function splitQuery(url) {
  const [pathname, query = ""] = String(url).split("?");
  return { pathname, params: new URLSearchParams(query) };
}

/** The slice of `list` that `url`'s page parameters ask for, as GitHub serves it. */
export function pageOf(url, list) {
  const { params } = splitQuery(url);
  const perPage = Math.min(Number(params.get("per_page")) || DEFAULT_PER_PAGE, MAX_PER_PAGE);
  const page = Math.max(Number(params.get("page")) || 1, 1);
  return list.slice((page - 1) * perPage, page * perPage);
}
