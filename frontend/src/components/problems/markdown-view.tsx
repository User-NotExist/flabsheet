import "katex/dist/katex.min.css";
import ReactMarkdown, { defaultUrlTransform, type UrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";

// remark-math marks formulas with these classes and rehype-katex looks for
// them, so they must survive sanitising. KaTeX runs after the sanitiser: its
// output is generated here, not written by the author.
const SCHEMA = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [
      ...(defaultSchema.attributes?.code ?? []),
      ["className", /^language-./, "math-inline", "math-display"],
    ],
  },
};

// Posts by students and staff (clarifications) may show images only from this
// site: an <img> pointing elsewhere would tell its host who read the thread
// and when. Resolving against a placeholder origin catches "//host" and other
// spellings of an absolute URL; `/api/images/…` stays. (An empty `src`
// protocol list in the sanitiser schema would allow everything, not nothing.)
const SAME_ORIGIN = "http://same-origin.invalid";

const localImagesOnly: UrlTransform = (url, key, node) => {
  const safe = defaultUrlTransform(url);
  if (key !== "src" || node.tagName !== "img") return safe;
  try {
    return new URL(safe, SAME_ORIGIN).origin === SAME_ORIGIN ? safe : null;
  } catch {
    return null;
  }
};

/**
 * Rendered Markdown: GitHub-flavoured, with KaTeX math. Raw HTML in the
 * source is not rendered and the tree is sanitised (NFR-SEC-03). The editor
 * preview and the student view must both go through this component so they
 * render identically (FR-PRB-05).
 *
 * Pass `userContent` for text any user wrote (clarification threads): it also
 * drops images hosted on other sites.
 */
export function MarkdownView({
  source,
  userContent = false,
}: {
  source: string;
  userContent?: boolean;
}) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeSanitize, SCHEMA], rehypeKatex]}
        urlTransform={userContent ? localImagesOnly : defaultUrlTransform}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
