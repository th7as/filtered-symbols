import {
    Disposable,
    DocumentSymbol,
    ExtensionContext,
    QuickInputButton,
    QuickInputButtonLocation,
    QuickPickItem,
    Range,
    Selection,
    SymbolKind,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
    ThemeIcon,
    commands,
    window,
    workspace,
} from 'vscode';

/**
 * Extends QuickPickItem.
 */
interface DocumentSymbolPickItem extends QuickPickItem {
    range: Range;
}

/**
 * Toggle button state for QuickPick buttons.
 */
interface InputButtonToggle {
    checked: boolean;
}

/**
 * Activates the Extension.
 *
 * @param context - Extension context
 */
export function activate(context: ExtensionContext) {
    context.subscriptions.push(
        commands.registerCommand('filteredSymbols.goToSymbolInEditor', async () => {
            const editor = window.activeTextEditor;

            if (editor) {
                const symbols = (await commands.executeCommand('vscode.executeDocumentSymbolProvider', editor.document.uri)) as DocumentSymbol[];
                await pickDocumentSymbol(symbols, editor);
            }
        }),
    );
}

let showAllFunctions: InputButtonToggle | undefined;
let showAllLevels: InputButtonToggle | undefined;
let showAllTypes: InputButtonToggle | undefined;

/**
 * Lets the user pick a document symbol.
 *
 * @param symbols - document symbols of the active editor
 * @param editor - active editor
 */
async function pickDocumentSymbol(symbols: DocumentSymbol[], editor: TextEditor): Promise<void> {
    const disposables: Disposable[] = [];
    let decoration: TextEditorDecorationType | undefined;

    try {
        return await new Promise<void>((resolve) => {
            const config = workspace.getConfiguration('filteredSymbols');
            const hideNestedFuncs = config.get<boolean>('hideNestedFunctions', false);
            const maxLevels = config.get<number>('maxLevelCount', 0);
            const symbolTypes = config.get<string[]>('symbolTypes', [
                'Module',
                'Namespace',
                'Package',
                'Interface',
                'Class',
                'Constructor',
                'Method',
                'Field',
                'Enum',
                'Function',
                'String',
                'Number',
                'Boolean',
                'Array',
                'Object',
                'Struct',
                'Event',
                'Operator',
            ]);

            const showAllFunctionsToggle = (showAllFunctions ??= { checked: !hideNestedFuncs });
            const showAllLevelsToggle = (showAllLevels ??= { checked: maxLevels < 1 });
            const showAllTypesToggle = (showAllTypes ??= { checked: symbolTypes.length === 0 });

            const quickPick = window.createQuickPick<DocumentSymbolPickItem>();
            quickPick.placeholder = 'Type to search / Select to navigate';

            const toggleButtons: QuickInputButton[] = [
                {
                    iconPath: new ThemeIcon('symbol-function'),
                    tooltip: 'Show functions/methods nested under other functions/methods',
                    location: QuickInputButtonLocation.Input,
                    toggle: showAllFunctionsToggle,
                },
            ];
            if (maxLevels > 0) {
                toggleButtons.push({
                    iconPath: new ThemeIcon('expand-all'),
                    tooltip: 'Show all nested levels',
                    location: QuickInputButtonLocation.Input,
                    toggle: showAllLevelsToggle,
                });
            }
            if (symbolTypes.length > 0) {
                toggleButtons.push({
                    iconPath: new ThemeIcon('symbol-class'),
                    tooltip: 'Show all symbol types',
                    location: QuickInputButtonLocation.Input,
                    toggle: showAllTypesToggle,
                });
            }
            quickPick.buttons = toggleButtons;

            const createItems = () =>
                getDocumentSymbols(
                    symbols,
                    showAllTypesToggle.checked ? [] : symbolTypes,
                    1,
                    showAllLevelsToggle.checked ? 0 : maxLevels,
                    !showAllFunctionsToggle.checked,
                );

            quickPick.items = createItems();

            let activeItem = getActiveSymbol(quickPick.items, editor);
            if (activeItem) {
                decoration = revealSymbol(activeItem, editor, decoration);
                quickPick.activeItems = [activeItem];
            }

            const originalRange = new Range(editor.selection.active, editor.selection.active);
            let firstChangeActive = true;
            let didAccept = false;

            disposables.push(
                quickPick.onDidTriggerButton(() => {
                    const previousActiveItem = quickPick.activeItems[0];
                    const items = createItems();
                    quickPick.items = items;
                    activeItem = previousActiveItem
                        ? items.find((item) => item.label === previousActiveItem.label && item.range.isEqual(previousActiveItem.range))
                        : undefined;
                    activeItem ??= getActiveSymbol(items, editor);

                    if (activeItem) {
                        decoration = revealSymbol(activeItem, editor, decoration);
                        quickPick.activeItems = [activeItem];
                    } else {
                        quickPick.activeItems = [];
                        if (decoration) {
                            editor.setDecorations(decoration, []);
                        }
                    }
                }),
                quickPick.onDidChangeActive((items) => {
                    if (items?.length) {
                        if (firstChangeActive && !activeItem) {
                            quickPick.activeItems = [];
                        } else {
                            activeItem = items[0];
                            decoration = revealSymbol(items[0], editor, decoration);
                        }
                        firstChangeActive = false;
                    } else if (decoration) {
                        editor.setDecorations(decoration, []);
                    }
                }),
                quickPick.onDidAccept(() => {
                    if (quickPick.selectedItems?.length) {
                        const item = quickPick.selectedItems[0];
                        editor.selection = new Selection(item.range.start, item.range.start);
                    }
                    didAccept = true;
                    quickPick.dispose();
                    resolve();
                }),
                quickPick.onDidHide(() => {
                    if (originalRange && !didAccept) {
                        editor.revealRange(originalRange);
                    }
                    quickPick.dispose();
                    resolve();
                }),
            );

            quickPick.show();
        });
    } finally {
        if (decoration) {
            decoration.dispose();
        }
        disposables.forEach((d) => d.dispose());
    }
}

/**
 * Creates the QuickPick items from the document symbols.
 *
 * @param symbols - document symbols
 * @param types - types of document symbols to show (shows all if empty)
 * @param level - current level of symbol nesting
 * @param maxLevels - maximum number of nested levels to show (shows all if 0)
 * @param hideNestedFuncs - true to hide functions nested under methods or other functions
 * @param parent - parent document symbol for child items
 *
 * @returns QuickPick items
 */
function getDocumentSymbols(
    symbols: DocumentSymbol[],
    types: string[],
    level: number,
    maxLevels: number,
    hideNestedFuncs: boolean,
    parent?: DocumentSymbol,
): DocumentSymbolPickItem[] {
    if (!symbols?.length) {
        return [];
    }

    if (types?.length) {
        symbols = symbols.filter((symbol) => {
            return (
                types.some((type) => symbol.kind === SymbolKind[type as keyof typeof SymbolKind]) &&
                (!hideNestedFuncs ||
                    (symbol.kind !== SymbolKind.Method && symbol.kind !== SymbolKind.Function) ||
                    !parent ||
                    (parent.kind !== SymbolKind.Method && parent.kind !== SymbolKind.Function && parent.kind !== SymbolKind.Constructor))
            );
        });
    }

    symbols.sort((a, b) => a.range.start.line - b.range.start.line);

    return symbols.flatMap((symbol) => {
        const item: DocumentSymbolPickItem = {
            label: `${'   '.repeat(level - 1)}$(symbol-${getSymbolIcon(symbol)}) ${symbol.name}`,
            description: parent ? `   → ${parent.name}` : undefined,
            range: symbol.range,
        };

        if (symbol.children?.length && (maxLevels < 1 || level < maxLevels)) {
            const children = getDocumentSymbols(symbol.children, types, level + 1, maxLevels, hideNestedFuncs, symbol);
            return [item, children].flat();
        }

        return item;
    });
}

/**
 * Gets the icon name for a document symbol.
 *
 * @param symbol - document symbol
 *
 * @returns icon name
 */
function getSymbolIcon(symbol: DocumentSymbol): string {
    return SymbolKind[symbol.kind].replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Gets the active document symbol at the cursor position.
 *
 * @param symbols - document symbols
 * @param editor - active editor
 *
 * @returns active document symbol
 */
function getActiveSymbol(symbols: readonly DocumentSymbolPickItem[], editor: TextEditor): DocumentSymbolPickItem | undefined {
    const cursorPosition = editor.selection.active;

    for (let i = symbols.length - 1; i >= 0; i--) {
        if (symbols[i].range.contains(cursorPosition)) {
            return symbols[i];
        }
    }

    return undefined;
}

/**
 * Reveals and highlights a document symbol.
 *
 * @param symbol - document symbol
 * @param editor - active editor
 * @param decoration - active decoration
 *
 * @returns decoration for highlighting
 */
function revealSymbol(
    symbol: DocumentSymbolPickItem,
    editor: TextEditor,
    decoration: TextEditorDecorationType | undefined,
): TextEditorDecorationType {
    decoration ??= window.createTextEditorDecorationType({
        backgroundColor: new ThemeColor('editor.rangeHighlightBackground'),
        isWholeLine: true,
    });

    editor.setDecorations(decoration, [symbol.range]);
    editor.revealRange(symbol.range);

    return decoration;
}
