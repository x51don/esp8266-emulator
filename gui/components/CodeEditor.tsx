/**
 * CodeMirror 6 wrapper for the Arduino sketch. Uncontrolled-ish: the App
 * owns the source string, we push external changes in and user edits out.
 */

import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, highlightActiveLine, drawSelection, dropCursor, rectangularSelection, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter } from '@codemirror/language';
import { cpp } from '@codemirror/lang-cpp';
import { oneDark } from '@codemirror/theme-one-dark';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';

interface Props {
  value: string;
  onChange: (v: string) => void;
}

export function CodeEditor({ value, onChange }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const state = EditorState.create({
      doc: value,
      extensions: [
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        EditorView.lineWrapping,
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        cpp(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        oneDark,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChangeRef.current(u.state.doc.toString());
        }),
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current! });
    viewRef.current = view;
    return () => view.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  return <div className="editor-host" ref={hostRef} />;
}
