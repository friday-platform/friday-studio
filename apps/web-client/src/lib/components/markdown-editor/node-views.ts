import { DOMSerializer, type Node } from "prosemirror-model";
import { NodeSelection, Plugin } from "prosemirror-state";
import type { NodeView } from "prosemirror-view";

/**
 * Renders a table as a non-editable atomic block. The cursor skips over it,
 * clicking selects the whole node, and Backspace/Delete removes it.
 */
export function tableNodeView(node: Node): NodeView {
  const serializer = DOMSerializer.fromSchema(node.type.schema);
  const table = document.createElement("table");
  table.contentEditable = "false";
  renderContent(table, node, serializer);

  return {
    dom: table,
    stopEvent: () => true,
    ignoreMutation: () => true,
    update(updated: Node) {
      if (updated.type !== node.type) return false;
      node = updated;
      table.innerHTML = "";
      renderContent(table, node, serializer);
      return true;
    },
    selectNode() {
      table.classList.add("ProseMirror-selectednode");
    },
    deselectNode() {
      table.classList.remove("ProseMirror-selectednode");
    },
  };
}

/**
 * Prevents the selection from ever landing inside a table node.
 * ProseMirror's document model has positions inside the table's content range
 * even though the NodeView is opaque — arrow keys and delete can resolve there.
 * This catches those cases and redirects to a NodeSelection on the table.
 *
 * Also ensures every table is followed by a paragraph so the browser's native
 * caret is always available after the table (like Linear's trailing text node).
 */
export function tableGuardPlugin(): Plugin {
  return new Plugin({
    appendTransaction(_transactions, _oldState, newState) {
      const tr = newState.tr;
      let modified = false;

      // Ensure every table has a trailing paragraph
      newState.doc.forEach((node, offset) => {
        if (node.type.name !== "table") return;
        const posAfter = offset + node.nodeSize;
        const nextNode =
          posAfter < newState.doc.content.size ? newState.doc.nodeAt(posAfter) : null;
        if (!nextNode || nextNode.type.name === "table") {
          const paraType = newState.schema.nodes.paragraph;
          if (!paraType) return;
          tr.insert(tr.mapping.map(posAfter), paraType.createAndFill()!);
          modified = true;
        }
      });

      // Redirect selection out of table internals
      const sel = modified ? tr.selection : newState.selection;
      if (!(sel instanceof NodeSelection)) {
        for (let d = sel.$from.depth; d > 0; d--) {
          if (sel.$from.node(d).type.name === "table") {
            const tablePos = tr.mapping.map(sel.$from.before(d));
            tr.setSelection(NodeSelection.create(tr.doc, tablePos));
            modified = true;
            break;
          }
        }
      }

      return modified ? tr : null;
    },
  });
}

function renderContent(table: HTMLTableElement, node: Node, serializer: DOMSerializer): void {
  node.forEach((row) => {
    const tr = document.createElement("tr");
    row.forEach((cell) => {
      const el = document.createElement(cell.type.name === "table_header" ? "th" : "td");
      el.appendChild(serializer.serializeFragment(cell.content));
      tr.appendChild(el);
    });
    table.appendChild(tr);
  });
}
