import CodeMirror from '@uiw/react-codemirror';
import { cpp } from '@codemirror/lang-cpp';
import { cn } from '@/lib/utils';

/**
 * CaseFileEditor - CodeMirror wrapper for editing an OpenFOAM case file.
 *
 * Isolated so the editor dependency lives only in the lazy edit-page chunk (and
 * so it can be mocked in tests). OpenFOAM dictionaries are C++-like, so the cpp
 * language gives sensible highlighting. Line numbers on; light theme to match
 * the app. The parent controls the height (this fills it).
 */
export interface CaseFileEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  className?: string;
}

export function CaseFileEditor({ value, onChange, readOnly = false, className }: CaseFileEditorProps) {
  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      editable={!readOnly}
      extensions={[cpp()]}
      theme="light"
      height="100%"
      basicSetup={{
        lineNumbers: true,
        foldGutter: false,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
      }}
      className={cn('h-full text-sm', className)}
    />
  );
}
