import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export function editorAccess(readOnly: boolean) {
  return [
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.contentAttributes.of({ "aria-readonly": String(readOnly) }),
  ];
}
