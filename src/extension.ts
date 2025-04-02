import {
    Disposable,
    DocumentSymbol,
    ExtensionContext,
    QuickPickItem,
    Range,
    Selection,
    SymbolKind,
    TextEditor,
    TextEditorDecorationType,
    ThemeColor,
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
        })
    );
}

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
            const symbolTypes = config.get<string[]>('symbolTypes', ['Class', 'Constructor', 'Method', 'Interface', 'Function']);
            const maxLevels = config.get<number>('maxLevelCount', 2);

            const quickPick = window.createQuickPick<DocumentSymbolPickItem>();
            quickPick.placeholder = 'Type to search / Select to navigate';
            quickPick.items = getDocumentSymbols(symbols, symbolTypes, 1, maxLevels);

            const activeItem = getActiveSymbol(quickPick.items, editor);
            if (activeItem) {
                decoration = revealSymbol(activeItem, editor);
                quickPick.activeItems = [activeItem];
            }

            const originalRange = editor.visibleRanges?.length ? editor.visibleRanges[0] : undefined;
            let firstChangeActive = true;
            let didAccept = false;

            disposables.push(
                quickPick.onDidChangeActive((items) => {
                    if (items?.length) {
                        if (firstChangeActive && !activeItem) {
                            quickPick.activeItems = [];
                        } else {
                            if (decoration) {
                                decoration.dispose();
                            }
                            decoration = revealSymbol(items[0], editor);
                        }
                        firstChangeActive = false;
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
                })
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
 * @param parent - name of parent for child items
 *
 * @returns QuickPick items
 */
function getDocumentSymbols(symbols: DocumentSymbol[], types: string[], level: number, maxLevels: number, parent?: string): DocumentSymbolPickItem[] {
    if (!symbols?.length) {
        return [];
    }

    if (types?.length) {
        symbols = symbols.filter((symbol) => types.some((type) => symbol.kind === SymbolKind[type as keyof typeof SymbolKind]));
    }

    symbols.sort((a, b) => a.range.start.line - b.range.start.line);

    return symbols.flatMap((symbol) => {
        const item: DocumentSymbolPickItem = {
            label: `${'   '.repeat(level - 1)}$(symbol-${getSymbolIcon(symbol)}) ${symbol.name}`,
            description: parent,
            range: symbol.range,
        };

        if (symbol.children?.length && (maxLevels < 1 || level < maxLevels)) {
            const children = getDocumentSymbols(symbol.children, types, level + 1, maxLevels, symbol.name);
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
 *
 * @returns decoration for highlighting
 */
function revealSymbol(symbol: DocumentSymbolPickItem, editor: TextEditor): TextEditorDecorationType {
    const decoration = window.createTextEditorDecorationType({
        backgroundColor: new ThemeColor('editor.rangeHighlightBackground'),
        isWholeLine: true,
    });

    editor.setDecorations(decoration, [symbol.range]);
    editor.revealRange(symbol.range);

    return decoration;
}
