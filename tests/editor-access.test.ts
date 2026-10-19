import test from "node:test";
import assert from "node:assert/strict";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { editorAccess } from "../src/editor-access.ts";

test("editor access can lock and unlock an existing state without losing its text or selection", () => {
  const access = new Compartment();
  let state = EditorState.create({
    doc: "人工审核输入",
    selection: { anchor: 3 },
    extensions: access.of(editorAccess(false)),
  });
  for (const readOnly of [true, false, true]) {
    state = state.update({
      effects: access.reconfigure(editorAccess(readOnly)),
    }).state;
    assert.equal(state.readOnly, readOnly);
    assert.equal(state.facet(EditorView.editable), !readOnly);
    assert.deepEqual(state.facet(EditorView.contentAttributes), [
      { "aria-readonly": String(readOnly) },
    ]);
    assert.equal(state.doc.toString(), "人工审核输入");
    assert.equal(state.selection.main.anchor, 3);
  }
});
