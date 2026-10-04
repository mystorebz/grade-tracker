// assets/js/lessons/canvas/tools/text-formats.js — text formats shared by
// Slides text boxes (tools/text.js) and the Document editor / viewer
// (document.js), so both formats offer and render exactly the same text styling.
//
//   font size      <span style="font-size">                (textStyle attribute)
//   line spacing   style="line-height" on p / h1-3 / li     setLineHeight / unsetLineHeight
//   indent         class="ql-indent-N" on p / h1-3 / li     indent / outdent; Tab / Shift-Tab in lists
//   Quill classes  <span class="ql-font-* | ql-size-*">     kept as-is (Quill-era content)
// (Font family is Tiptap's FontFamily; both editors add it.)

export const INDENT_TYPES = Object.freeze(['paragraph', 'heading', 'listItem']);
const LINE_TYPES = INDENT_TYPES;

export function sharedTextExtensions(T) {
    const FontSize = T.Extension.create({
        name: 'fontSize',
        addGlobalAttributes() {
            return [{
                types: ['textStyle'],
                attributes: {
                    fontSize: {
                        default: null,
                        parseHTML: (el) => el.style.fontSize || null,
                        renderHTML: (a) => (a.fontSize ? { style: `font-size: ${a.fontSize}` } : {}),
                    },
                },
            }];
        },
        addCommands() {
            return {
                setFontSize: (size) => ({ chain }) => chain().setMark('textStyle', { fontSize: size }).run(),
                unsetFontSize: () => ({ chain }) => chain().setMark('textStyle', { fontSize: null }).removeEmptyTextStyle().run(),
            };
        },
    });

    const LineHeight = T.Extension.create({
        name: 'lineHeight',
        addGlobalAttributes() {
            return [{
                types: LINE_TYPES,
                attributes: {
                    lineHeight: {
                        default: null,
                        parseHTML: (el) => el.style.lineHeight || null,
                        renderHTML: (a) => (a.lineHeight ? { style: `line-height: ${a.lineHeight}` } : {}),
                    },
                },
            }];
        },
        addCommands() {
            return {
                setLineHeight: (lineHeight) => ({ commands }) => LINE_TYPES.map((t) => commands.updateAttributes(t, { lineHeight })).some(Boolean),
                unsetLineHeight: () => ({ commands }) => LINE_TYPES.map((t) => commands.resetAttributes(t, 'lineHeight')).some(Boolean),
            };
        },
    });

    // Quill-style flat indent (class ql-indent-1…8), lists included
    const Indent = T.Extension.create({
        name: 'blockIndent',
        priority: 1000,
        addGlobalAttributes() {
            return [{
                types: INDENT_TYPES,
                attributes: {
                    indent: {
                        default: 0,
                        parseHTML: (el) => Number((/\bql-indent-(\d)\b/.exec(el.className || '') || [])[1]) || 0,
                        renderHTML: (a) => (a.indent ? { class: `ql-indent-${a.indent}` } : {}),
                    },
                },
            }];
        },
        addCommands() {
            const step = (dir) => () => ({ state, tr, dispatch }) => {
                let changed = false;
                const { from, to } = state.selection;
                state.doc.nodesBetween(from, to, (node, pos) => {
                    if (!INDENT_TYPES.includes(node.type.name)) return true;
                    // inside a list item, indent the item, not its paragraph
                    if (node.type.name === 'paragraph' && state.doc.resolve(pos).parent.type.name === 'listItem') return false;
                    const next = Math.max(0, Math.min(8, (node.attrs.indent || 0) + dir));
                    if (next !== (node.attrs.indent || 0)) { tr.setNodeMarkup(pos, undefined, { ...node.attrs, indent: next }); changed = true; }
                    return node.type.name !== 'listItem';
                });
                if (changed && dispatch) dispatch(tr);
                return changed;
            };
            return { indent: step(1), outdent: step(-1) };
        },
        addKeyboardShortcuts() {
            return {
                Tab: () => this.editor.isActive('listItem') && this.editor.commands.indent(),
                'Shift-Tab': () => this.editor.isActive('listItem') && this.editor.commands.outdent(),
            };
        },
    });

    // Quill-era <span class="ql-font-serif|ql-size-large"> — keep the class
    const QuillClassSpan = T.Mark.create({
        name: 'quillClass',
        addAttributes() { return { cls: { default: null } }; },
        parseHTML() {
            return [{
                tag: 'span[class]',
                getAttrs: (el) => {
                    const cls = (el.className || '').split(/\s+/).filter((c) => /^ql-(font|size)-/.test(c)).join(' ');
                    return cls ? { cls } : false;
                },
                consuming: false,
            }];
        },
        renderHTML({ HTMLAttributes }) { return ['span', { class: HTMLAttributes.cls }, 0]; },
    });

    return [T.FontFamily, FontSize, LineHeight, Indent, QuillClassSpan];
}

// Format menu (Slides and Documents share it — builder.js menuModel / docMenuModel).
// st: readEditorState()-shaped state or null. Returns menu items for builder's
// menuItemsHtml(); commands: format.<cmd>[.<arg>] → toolbar.runTextCommand().
export function textFormatMenu({ item, SEP, st, disabled = false, fonts, sizes, lineHeights }) {
    const on = (k) => !!(st && st[k]);
    const sizeNow = st && st.fontSize ? String(parseInt(st.fontSize, 10)) : '';
    return [
        item('format.bold', 'Bold', { icon: 'fa-bold', kbd: 'Ctrl+B', checked: on('bold'), disabled }),
        item('format.italic', 'Italic', { icon: 'fa-italic', kbd: 'Ctrl+I', checked: on('italic'), disabled }),
        item('format.underline', 'Underline', { icon: 'fa-underline', kbd: 'Ctrl+U', checked: on('underline'), disabled }),
        item('format.strike', 'Strikethrough', { icon: 'fa-strikethrough', checked: on('strike'), disabled }),
        SEP,
        item('format.font', 'Font', { icon: 'fa-font', disabled, sub: fonts.map(([v, l], i) => item(`format.font.${i}`, l, { checked: (st?.fontFamily || '') === v })) }),
        item('format.size', 'Font size', { icon: 'fa-text-height', disabled, sub: [item('format.size.default', 'Default', { checked: !sizeNow }), ...sizes.map((s) => item(`format.size.${parseInt(s, 10)}`, `${parseInt(s, 10)} px`, { checked: sizeNow === String(parseInt(s, 10)) }))] }),
        item('format.block', 'Paragraph styles', { icon: 'fa-heading', disabled, sub: [['p', 'Normal text'], ['1', 'Heading 1'], ['2', 'Heading 2'], ['3', 'Heading 3']].map(([v, l]) => item(`format.block.${v}`, l, { checked: (st?.block || 'p') === v })) }),
        item('format.align', 'Align', { icon: 'fa-align-left', disabled, sub: ['left', 'center', 'right', 'justify'].map((a) => item(`format.align.${a}`, a[0].toUpperCase() + a.slice(1), { icon: `fa-align-${a}`, checked: (st?.align || 'left') === a })) }),
        item('format.lineHeight', 'Line spacing', { icon: 'fa-arrows-up-down', disabled, sub: [['', 'Default'], ...lineHeights].map(([v, l]) => item(`format.lineHeight.${v || 'default'}`, l, { checked: (st?.lineHeight || '') === v })) }),
        item('format.indent', 'Increase indent', { icon: 'fa-indent', kbd: 'Tab', disabled }),
        item('format.outdent', 'Decrease indent', { icon: 'fa-outdent', kbd: 'Shift+Tab', disabled }),
        item('format.bullet', 'Bulleted list', { icon: 'fa-list-ul', checked: on('bullet'), disabled }),
        item('format.ordered', 'Numbered list', { icon: 'fa-list-ol', checked: on('ordered'), disabled }),
        SEP,
        item('format.clear', 'Clear formatting', { icon: 'fa-text-slash', disabled }),
    ];
}

// format.<action>.<arg> → [toolbar command, value]
export function textFormatCommand(cmd, fonts) {
    const [, action, ...rest] = cmd.split('.');
    const arg = rest.join('.');
    if (['bold', 'italic', 'underline', 'strike', 'bullet', 'ordered', 'clear', 'indent', 'outdent'].includes(action)) return [action];
    if (action === 'align' || action === 'block') return [action, arg];
    if (action === 'lineHeight') return ['lineHeight', arg === 'default' ? '' : arg];
    if (action === 'font') return ['font', (fonts[Number(arg)] || [''])[0]];
    if (action === 'size') return ['size', arg === 'default' ? '' : `${arg}px`];
    return null;
}
