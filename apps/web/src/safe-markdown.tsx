import { Fragment, type ReactNode } from "react";
import { tokenizeProjectFileReferences } from "@gitpm/shared";
import { renderProjectFileReferenceText, type ProjectFileReferenceContext } from "./project-file-reference-ui.js";

export type SafeMarkdownTextRenderer = (source: string, key: string) => ReactNode;

function plainText(source: string, key: string): ReactNode {
  return <Fragment key={key}>{source}</Fragment>;
}

function boldMarkdown(text: string, renderText: SafeMarkdownTextRenderer): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/gu).map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={index}>{renderText(part.slice(2, -2), `strong:${index}`)}</strong>
    : <Fragment key={index}>{renderText(part, `text:${index}`)}</Fragment>);
}

function inlineMarkdown(text: string, fileContext: ProjectFileReferenceContext | undefined, renderText: SafeMarkdownTextRenderer): ReactNode[] {
  if (fileContext === undefined) return boldMarkdown(text, renderText);
  const segments = tokenizeProjectFileReferences(text);
  let marker = "\u0000";
  while (text.includes(marker)) marker += "\u0000";
  const references = segments.filter((segment) => segment.kind === "file_reference");
  let referenceIndex = 0;
  const protectedText = segments.map((segment) => segment.kind === "text" ? segment.value : `${marker}${referenceIndex++}${marker}`).join("");
  const expand = (part: string, key: string): ReactNode[] => part.split(new RegExp(`(${marker}\\d+${marker})`, "gu")).filter(Boolean).map((piece, index) => {
    const match = new RegExp(`^${marker}(\\d+)${marker}$`, "u").exec(piece);
    return match === null
      ? <Fragment key={`${key}:${index}`}>{renderText(piece, `${key}:${index}:text`)}</Fragment>
      : <Fragment key={`${key}:${index}`}>{renderProjectFileReferenceText(references[Number(match[1])]!.raw, fileContext)}</Fragment>;
  });
  return protectedText.split(/(\*\*[^*]+\*\*)/gu).map((part, index) => part.startsWith("**") && part.endsWith("**")
    ? <strong key={index}>{expand(part.slice(2, -2), `strong:${index}`)}</strong>
    : <Fragment key={index}>{expand(part, `text:${index}`)}</Fragment>);
}

export function SafeMarkdown({ fileContext, renderText = plainText, source }: {
  readonly fileContext?: ProjectFileReferenceContext;
  readonly renderText?: SafeMarkdownTextRenderer;
  readonly source: string;
}) {
  return <div className="safe-markdown">{source.split(/\r?\n/u).map((line, index) => {
    if (line.startsWith("# ")) return <h4 key={index}>{inlineMarkdown(line.slice(2), fileContext, renderText)}</h4>;
    if (line.startsWith("- ")) return <div className="markdown-list-item" key={index}>• {inlineMarkdown(line.slice(2), fileContext, renderText)}</div>;
    return line === "" ? <br key={index} /> : <p key={index}>{inlineMarkdown(line, fileContext, renderText)}</p>;
  })}</div>;
}
