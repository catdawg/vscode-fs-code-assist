import { basename } from "path";
import { CancellationToken, Color, ColorInformation, ColorPresentation, CompletionItem, CompletionItemKind, DecorationRangeBehavior, DocumentLink, DocumentSymbol, ExtensionContext, FoldingContext, FoldingRange, FoldingRangeKind, Hover, languages, Location, MarkdownString, Position, ProviderResult, Range, SymbolInformation, SymbolKind, TextDocument, TextDocumentWillSaveEvent, Uri, window, workspace } from "vscode";
import { RawSymbolInformation, TaskRunner } from "./project-symbol-indexer";
import { activate as adoc_autocomplete } from './adoc-autocomplete';

const LANGUAGE_SELECTOR = "lua";

class StingrayLuaLanguageServer {
	private _initialized = false;
	private _symbols = new Map<String, SymbolInformation[]>();
	private _textures = new Map<String, Uri>();

	constructor() {
		workspace.onWillSaveTextDocument(this.onWillSaveTextDocument.bind(this));
	}

	pushSymbolData(symbol: RawSymbolInformation) {
		const { name, path, line, char, kind, parent } = symbol;
		let list = this._symbols.get(name);
		if (!list) {
			list = [];
			this._symbols.set(name, list);
		}
		const location = new Location(Uri.file(path), new Position(line, char));
		list.push(new SymbolInformation(name, SymbolKind[kind], parent || "", location));
	}

	async symbols() {
		await this._ensureInitialized();
		return this._symbols;
	}

	async textures() {
		await this._ensureInitialized();
		return this._textures;
	}

	async _ensureInitialized() {
		if (!this._initialized) {
			this._initialized = true;
			await this.parseAllLuaFiles();
			await this.indexTextureFiles();
		}
	}

	async parseAllLuaFiles(token?: CancellationToken) {
		const uris = await workspace.findFiles("{foundation,scripts}/**/*.lua");
		const indexer = new TaskRunner("parseFileSymbols", uris.map((uri) => uri.fsPath), this.pushSymbolData.bind(this));
		token?.onCancellationRequested(() => {
			indexer.abort();
		});
		try {
			const elapsed = await indexer.run();
			window.showInformationMessage(`Indexed ${uris.length} files in ${Math.floor(elapsed)} ms using up to ${indexer.threadCount} worker threads.`);
		} catch (e) {
			window.showErrorMessage((e as Error).message);
		}
	}
	
	async indexTextureFiles() {
		const uris = await workspace.findFiles("{.gui_source_textures,gui/1080p/single_textures}/**/*.png");
		for (const uri of uris) {
			this._textures.set(basename(uri.path, ".png"), uri);
		}
	}

	onWillSaveTextDocument(event: TextDocumentWillSaveEvent) {
		if (event.document.languageId === "lua") {
			//this.parseLuaFile(event.document.uri);
		}
	}
}


export function activate(context: ExtensionContext) {
	const server = new StingrayLuaLanguageServer();

	adoc_autocomplete(context);

	context.subscriptions.push(languages.registerDefinitionProvider(LANGUAGE_SELECTOR, {
		provideDefinition: async function (document: TextDocument, position: Position, token: CancellationToken): Promise<Location[] | undefined> {
			const wordRange = document.getWordRangeAtPosition(position, /[\w_]+/);
			if (!wordRange) {
				return undefined;
			}
			const word = document.getText(wordRange);
			const symbols = await server.symbols();
			return symbols.get(word)?.map((sym) => sym.location);
		}
	}));

	context.subscriptions.push(languages.registerWorkspaceSymbolProvider({
		provideWorkspaceSymbols: async function (query: string, token: CancellationToken): Promise<SymbolInformation[] | undefined> {
			const symbols = await server.symbols();
			query = query.toLowerCase();
			let result: SymbolInformation[] = [];
			for (const [key, symbolList] of symbols) {
				if (key.toLowerCase().includes(query)) {
					result = result.concat(symbolList);
				}
			}
			return result;
		}
	}));


	const IF_BEGIN_REGEX = /^\s*--IF_BEGIN/;
	const IF_END_REGEX = /^\s*--IF_END/;
	const IF_LINE_REGEX = /--IF_LINE/;

	const preprocessorDimDecoration = window.createTextEditorDecorationType({
		opacity: "0.75",
		//backgroundColor: backgroundColor,
		//color: color,
		rangeBehavior: DecorationRangeBehavior.OpenOpen
	});

	context.subscriptions.push(languages.registerFoldingRangeProvider(LANGUAGE_SELECTOR, {
		provideFoldingRanges(document: TextDocument, context: FoldingContext, token: CancellationToken) {
			const foldingRanges = [];
			const decoratorRanges = [];
			const regionStack = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				if (IF_BEGIN_REGEX.test(text)) {
					regionStack.push(i);
				} else if (IF_END_REGEX.test(text)) {
					const start = <number> regionStack.pop();
					foldingRanges.push(new FoldingRange(start, i-1, FoldingRangeKind.Region));
					decoratorRanges.push(new Range(start+1, 0, i, 0));
				} else if (regionStack.length === 0) {
					const ifLineBegin = text.indexOf("--IF_LINE");
					if (ifLineBegin !== -1) {
						decoratorRanges.push(new Range(i, 0, i, ifLineBegin));
					}
				}
			}

			const editors = window.visibleTextEditors.filter(e => e.document.uri.toString() === document.uri.toString());
			for (const e of editors) {
				e.setDecorations(preprocessorDimDecoration, decoratorRanges);
			}

			if (regionStack.length !== 0) {
				//console.log('Unbalanced preprocessor directives!');
			}

			return []; //foldingRanges;// Temporarily disabled because it breaks regular folding.
		}
	}));

	type MethodData = {
		name: string;
		args: string[];
	};

	const methodList: MethodData[] = [];

	const CLASS_REGEX = /^(\w+)\s*=\s*class/;
	const OBJECT_REGEX = /^(\w+)\s*=\s*\1/;
	const METHOD_REGEX = /^function\s+(\w+)[:.]([\w_]+)\(([^)]*)\)/;
	const FUNCTION_REGEX = /^function\s+([\w_]+)\(/;
	const ENUM_REGEX = /([\w_]+)\s*=\s*table\.enum\(/;
	const CONST_REGEX = /^(?:local\s+)?([A-Z_]+)\s*=/;
	const LOCAL_REGEX = /^local(?:\s+function)?\s+([\w_]+)\b/;
	context.subscriptions.push(languages.registerDocumentSymbolProvider(LANGUAGE_SELECTOR, {
		provideDocumentSymbols(document, token) {
			const symbols = [];
			const symbolLookup = new Map<string, DocumentSymbol>();

			methodList.length = 0; // Clear the array, JavaScript style.

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;
				const range = new Range(i, 0, i, 0);
				const selectionRange = new Range(i, 0, i, 0);

				const methodMatches = METHOD_REGEX.exec(text);
				if (methodMatches) {
					const [_, mClass, mMethod, mArgs] = methodMatches;
					const kind = (mMethod === "init") ? SymbolKind.Constructor : SymbolKind.Method;					
					const symbol = new DocumentSymbol(mMethod, mClass, kind, range, selectionRange);
					const parent = symbolLookup.get(mClass);
					if (parent) {
						parent.children.push(symbol);
					} else {
						symbols.push(symbol);
					}
					methodList.push({
						name: mMethod,
						args: mArgs.split(/\s*,\s*/),
					});
					continue;
				}

				const functionMatches = FUNCTION_REGEX.exec(text);
				if (functionMatches) {
					const [_, mFunc] = functionMatches;
					symbols.push(new DocumentSymbol(mFunc, "", SymbolKind.Function, range, selectionRange));
					continue;
				}

				const classMatches = CLASS_REGEX.exec(text);
				if (classMatches) {
					const [_, mClass] = classMatches;
					const symbol = new DocumentSymbol(mClass, "", SymbolKind.Class, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mClass, symbol);
					continue;
				}

				const objectMatches = OBJECT_REGEX.exec(text);
				if (objectMatches) {
					const [_, mObj] = objectMatches;
					const symbol = new DocumentSymbol(mObj, "", SymbolKind.Object, range, selectionRange);
					symbols.push(symbol);
					symbolLookup.set(mObj, symbol);
					continue;
				}

				const enumMatches = ENUM_REGEX.exec(text);
				if (enumMatches) {
					const [_, mEnum] = enumMatches;
					symbols.push(new DocumentSymbol(mEnum, "", SymbolKind.Enum, range, selectionRange));
					continue;
				}

				const constMatches = CONST_REGEX.exec(text);
				if (constMatches) {
					const [_, mConst] = constMatches;
					symbols.push(new DocumentSymbol(mConst, "", SymbolKind.Constant, range, selectionRange));
					continue;
				}

				const localMatches = LOCAL_REGEX.exec(text);
				if (localMatches) {
					const [_, mLocal] = localMatches;
					symbols.push(new DocumentSymbol(mLocal, "", SymbolKind.Variable, range, selectionRange));
					continue;
				}
			}
			return symbols;
		}
	}));

	const COLOR_REGEX = /\{\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\}/d;
	context.subscriptions.push(languages.registerColorProvider(LANGUAGE_SELECTOR, {
		provideColorPresentations(color, context, token) {
			const cA = (255*color.alpha).toFixed(0);
			const cR = (255*color.red).toFixed(0);
			const cG = (255*color.green).toFixed(0);
			const cB = (255*color.blue).toFixed(0);
			const presentation = new ColorPresentation(`{${cA},${cR},${cG},${cB}}`);
			// presentation.textEdit = new TextEdit()
			return [ presentation ];
		},
		provideDocumentColors(document, token) {
			const colors = [];

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const colorMatches = COLOR_REGEX.exec(text);
				if (colorMatches) {
					const [_, cA, cR, cG, cB] = colorMatches;
					const color = new Color(parseInt(cR, 10)/255, parseInt(cG, 10)/255, parseInt(cB, 10)/255, parseInt(cA, 10)/255);
					const indices = (<any> colorMatches).indices; // Ugly hack to shut up TypeScript.
					const range = new Range(i, indices[0][0], i, indices[0][1]);
					colors.push(new ColorInformation(range, color));
				}
				
			}

			return colors;
		}
	}));


	context.subscriptions.push(languages.registerHoverProvider(LANGUAGE_SELECTOR, {
		async provideHover(document: TextDocument, position: Position, token: CancellationToken): Promise<Hover | undefined> {
			const workspaceFolders = workspace.workspaceFolders;
			const folder = workspaceFolders && workspaceFolders[0];
			if (!folder) {
				return;
			}

			const line = document.lineAt(position.line);
			const text = line.text;
			const stringOpen = text.lastIndexOf('"', position.character);
			const stringClose = text.indexOf('"', position.character);
			if (stringOpen === -1 || stringClose === -1) {
				return;
			}
			const hoverRange = new Range(
				new Position(position.line, stringOpen),
				new Position(position.line, 1+stringClose)
			);
			const path = text.substring(1+stringOpen, stringClose);
			const textures = await server.textures();
			const uri = textures.get(path);
			if (!uri) {
				return;
			}
			const mdString = new MarkdownString();
			mdString.supportHtml = true;
			mdString.appendMarkdown(`<img src='${uri.toString()}'>`);
			return new Hover(mdString, hoverRange);
		}
	}));

	context.subscriptions.push(languages.registerCompletionItemProvider(LANGUAGE_SELECTOR, {
		provideCompletionItems(document, position, token, context) {
			const range = new Range(position.line, position.character-5, position.line, position.character-1);
			const word = document.getText(range);
			if (word !== "self") {
				return null;
			}
			return methodList.map((method) => {
				const item = new CompletionItem(method.name, CompletionItemKind.Function);
				item.detail = "(method)";
				item.documentation = "Tell me if you can see this.";
				return item;
			});
		}
	}, ":"));
	/*
	languages.registerSignatureHelpProvider(LANGUAGE_SELECTOR, {
		provideSignatureHelp(document, position, token, context) {
			const text = document.lineAt(position).text;
			const start = text.lastIndexOf("self:", position.character);
			if (start === -1) {
				return null;
			}
			return {
				signatures: [
					new SignatureInformation("label", "documentation")
				],
				activeSignature: 0,
				activeParameter: 0,
			};
		}
	}, "(,");
	*/

	const LINK_REGEX = /@?([\w_/]+\.lua)(?::(\d+))?/d;
	context.subscriptions.push(languages.registerDocumentLinkProvider("stingray-output", {
		provideDocumentLinks(document, token) {
			const links: DocumentLink[] = [];

			const workspaceFolders = workspace.workspaceFolders;
			const folder = workspaceFolders && workspaceFolders[0];

			if (!folder) {
				return links;
			}

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				const linkMatches = LINK_REGEX.exec(text);
				if (linkMatches) {
					const indices = (<any> linkMatches).indices;
					const range = new Range(i, indices[0][0], i, indices[0][1]);
					const line = linkMatches[2] ? parseInt(linkMatches[2], 10) : 1;
					const uri = Uri.parse(`vscode://file/${folder.uri.fsPath}/${linkMatches[1]}:${line}`);
					links.push(new DocumentLink(range, uri));
				}
			}

			return links;
		}
	}));

	/*
	const SEMANTIC_TOKENS_LEGEND = {
		tokenModifiers: [],
		tokenTypes: [],
	};
	languages.registerDocumentSemanticTokensProvider(LANGUAGE_SELECTOR, {
		provideDocumentSemanticTokens(document, token,) {
			const builder = new SemanticTokensBuilder(SEMANTIC_TOKENS_LEGEND);
			const regionStack: boolean[] = []; // True signals that the line should be commented out.

			for (let i=0; i < document.lineCount; ++i) {
				const line = document.lineAt(i);
				const text = line.text;

				if (IF_BEGIN_REGEX.test(text)) {
					regionStack.push(Math.random() < 0.5);
				} else if (IF_END_REGEX.test(text)) {
					regionStack.pop();
				}

				if (regionStack[0]) {
					builder.push(i, 1, text.length, token.type);
				}
			}

			return builder.build();
		}
	}, SEMANTIC_TOKENS_LEGEND);
	//*/
}

/* Putting these links here as a dirty scratchpad:
https://regex101.com/
https://github.com/winlibs/oniguruma/blob/master/doc/RE
https://www.regular-expressions.info/lookaround.html
https://github.com/microsoft/vscode/blob/1e810cafb7461ca077c705499408ca838524c014/extensions/theme-monokai/themes/monokai-color-theme.json
*/