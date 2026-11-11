import "katex/dist/katex.min.css";
import ReactMarkdown from "react-markdown";
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

/**
 * Rendered Markdown: GitHub-flavoured, with KaTeX math. Raw HTML in the
 * source is not rendered and the tree is sanitised (NFR-SEC-03). The editor
 * preview and the student view must both go through this component so they
 * render identically (FR-PRB-05).
 */
export function MarkdownView({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeSanitize, SCHEMA], rehypeKatex]}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
