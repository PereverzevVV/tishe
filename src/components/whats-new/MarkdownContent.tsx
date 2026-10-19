import React from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";

interface MarkdownContentProps {
  markdown: string;
}

const allowedElements = [
  "a",
  "blockquote",
  "br",
  "code",
  "em",
  "h1",
  "h2",
  "h3",
  "hr",
  "img",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

const isSafeUrl = (url: string) => {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol);
  } catch {
    return false;
  }
};

const openSafeUrl = async (url: string) => {
  if (!isSafeUrl(url)) return;

  try {
    await openUrl(url);
  } catch (error) {
    console.error("Failed to open release note link:", error);
  }
};

const isSafeImageSrc = (src: string) => {
  if (!src.startsWith("/release-notes/")) return false;
  if (src.includes("\\") || src.includes("..")) return false;

  return true;
};

const components: Components = {
  h1: ({ children }) => <h3 className="font-semibold">{children}</h3>,
  h2: ({ children }) => <h3 className="font-semibold">{children}</h3>,
  h3: ({ children }) => <h3 className="font-semibold">{children}</h3>,
  p: ({ children }) => <p className="t-type-prose">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc space-y-1 ps-5 t-type-prose">{children}</ul>
  ),
  li: ({ children }) => (
    <li className="ps-1 marker:text-t-tertiary">{children}</li>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal space-y-1 ps-5 t-type-prose">{children}</ol>
  ),
  br: () => <br />,
  hr: () => <hr className="border-t-separator" />,
  img: ({ alt, src }) => {
    if (!src || !isSafeImageSrc(src)) return null;

    return (
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        decoding="async"
        className="mx-auto block max-h-72 max-w-full object-contain"
      />
    );
  },
  blockquote: ({ children }) => (
    <blockquote className="ps-3 t-type-prose t-text-secondary">
      {children}
    </blockquote>
  ),
  code: ({ children, className }) => {
    const isBlock = className?.startsWith("language-");

    if (isBlock) {
      return (
        <code className="block whitespace-pre font-mono text-xs">
          {children}
        </code>
      );
    }

    return <code className="rounded bg-t-fill px-1 font-mono">{children}</code>;
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-md bg-t-fill p-3 font-mono t-type-caption">
      {children}
    </pre>
  ),
  a: ({ children, href }) => {
    if (!href || !isSafeUrl(href)) {
      return <>{children}</>;
    }

    return (
      <a
        href={href}
        rel="noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void openSafeUrl(href);
        }}
        className="t-link"
      >
        {children}
      </a>
    );
  },
};

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  markdown,
}) => {
  return (
    <div className="space-y-3">
      <ReactMarkdown
        allowedElements={allowedElements}
        components={components}
        skipHtml
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
};
