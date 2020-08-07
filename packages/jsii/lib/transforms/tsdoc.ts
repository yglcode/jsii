import * as ts from 'typescript';

export function rewriteTsdocBundle(ctx: ts.TransformationContext) {
  return (source: ts.SourceFile | ts.Bundle): ts.SourceFile | ts.Bundle => {
    if (ts.isBundle(source)) {
      throw new Error('bundles not supported yet'); // FIXME
    }

    return ts.visitEachChild(source, visitor, ctx);

    function visitor(node: ts.Node): ts.Node {
      const handled = handleNode(node, source as ts.SourceFile);
      return ts.visitEachChild(handled, visitor, ctx);
    }
  };
}

export function rewriteTsdoc(ctx: ts.TransformationContext) {
  return (source: ts.SourceFile): ts.SourceFile => {
    return ts.visitEachChild(source, visitor, ctx);

    function visitor(node: ts.Node): ts.Node {
      const handled = handleNode(node, source);
      return ts.visitEachChild(handled, visitor, ctx);
    }
  };
}

function handleNode(node: ts.Node, source: ts.SourceFile): ts.Node {
  if (ts.isClassDeclaration(node)) {
    const comment = tsdocExperimental(node, source);
    if (comment !== undefined) {
      return updateExperimentalDocString(node, comment);
    }
  }
  return node;
}

function tsdocExperimental(
  node: ts.Node,
  source: ts.SourceFile,
): CommentRange | undefined {
  const nodeText = node.getFullText(source);
  const commentranges = ts.getLeadingCommentRanges(nodeText, 0);
  if (!commentranges) {
    return undefined;
  }
  const filtered = commentranges
    .map((cr) => {
      return {
        ...cr,
        commentText: nodeText.slice(cr.pos, cr.end),
      };
    })
    .filter((cr) => {
      const commentText = nodeText.slice(cr.pos, cr.end);
      const experimentalRegex = new RegExp('@experimental\\s');
      if (
        cr.kind === ts.SyntaxKind.MultiLineCommentTrivia &&
        commentText.startsWith('/**') &&
        experimentalRegex.exec(commentText) !== null
      ) {
        return true;
      }
      return false;
    });
  if (filtered.length === 0) {
    return undefined;
  } else if (filtered.length > 1) {
    throw new Error('more than one tsdoc'); // FIXME
  }
  return filtered[0];
}

function updateExperimentalDocString(
  node: ts.Node,
  comment: CommentRange,
): ts.Node {
  // const nodeText = node.getFullText(node.getSourceFile());
  // const commentranges = ts.getLeadingCommentRanges(nodeText, 0);
  const commentranges = undefined;

  const nocomments = commentranges
    ? ts.setTextRange(node, {
        pos: node.getStart(),
        end: node.getEnd(),
      })
    : node;

  const newComment = `* EXPERIMENTAL API ${comment.commentText.slice(
    3,
    comment.commentText.length - 3,
  )}`;

  // Now adding a new synthetic comment as a replacement
  return ts.addSyntheticLeadingComment(
    nocomments,
    comment.kind,
    newComment,
    comment.hasTrailingNewLine,
  );
}

interface CommentRange extends ts.CommentRange {
  readonly commentText: string;
}
