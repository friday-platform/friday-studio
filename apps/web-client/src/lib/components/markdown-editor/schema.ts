import type { NodeSpec } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";

// Start with basic schema nodes + list nodes, then remove unwanted
const withLists = addListNodes(basicSchema.spec.nodes, "paragraph block*", "block");

// Remove nodes we don't support
const filtered = withLists
  .remove("image")
  // Add `params` attr to code_block (basic schema lacks it, needed for fence info)
  .update("code_block", { ...withLists.get("code_block"), attrs: { params: { default: "" } } });

// Add table nodes
const tableNodes: Record<string, NodeSpec> = {
  table: {
    content: "table_row+",
    group: "block",
    atom: true,
    parseDOM: [{ tag: "table" }],
    toDOM() {
      return ["table", 0];
    },
  },
  table_row: {
    content: "(table_header | table_cell)+",
    parseDOM: [{ tag: "tr" }],
    toDOM() {
      return ["tr", 0];
    },
  },
  table_header: {
    content: "inline*",
    isolating: true,
    parseDOM: [{ tag: "th" }],
    toDOM() {
      return ["th", 0];
    },
  },
  table_cell: {
    content: "inline*",
    isolating: true,
    parseDOM: [{ tag: "td" }],
    toDOM() {
      return ["td", 0];
    },
  },
};

const nodes = filtered.append(tableNodes);

const marks = basicSchema.spec.marks;

export const editorSchema = new Schema({ nodes, marks });
