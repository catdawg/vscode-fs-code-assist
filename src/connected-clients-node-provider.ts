// implements tree view UI for connected clients
import * as vscode from 'vscode';
import { connectionHandler } from './connection-handler';
import { StingrayConnection } from './stingray-connection';

export class ConnectedClientsNodeProvider implements vscode.TreeDataProvider<ConnectedClientTreeItem> {
	private _onDidChangeTreeData: vscode.EventEmitter<ConnectedClientTreeItem | undefined | void> = new vscode.EventEmitter<ConnectedClientTreeItem | undefined | void>();
	readonly onDidChangeTreeData: vscode.Event<ConnectedClientTreeItem | undefined | void> = this._onDidChangeTreeData.event;

	getTreeItem(element: ConnectedClientTreeItem): vscode.TreeItem | Thenable<vscode.TreeItem> {
		return element;
	}
	getChildren(element?: ConnectedClientTreeItem): vscode.ProviderResult<ConnectedClientTreeItem[]> {
		return Promise.resolve(this._gatherClientConnections());
	}
	refresh(): void {
		this._onDidChangeTreeData.fire();
	}

	private _gatherClientConnections() {
		const openConnections = connectionHandler.getAllGames();
		const treeItems: ConnectedClientTreeItem[] = [];
		openConnections.forEach(connection => {
			const newItem = new ConnectedClientTreeItem(
				connection.name,
				connectionHandler.getOutputForConnection(connection) as vscode.OutputChannel,
				connection );
			treeItems.push(newItem);
		});
		return treeItems;
	}
}

export class ConnectedClientTreeItem extends vscode.TreeItem {
	constructor(
		public readonly label: string,
		private readonly connectionOutput: vscode.OutputChannel,
		public readonly connection: StingrayConnection
	) {
		super(label, vscode.TreeItemCollapsibleState.None);
	}

	focusOutput() {
		if (this.connectionOutput) {
			this.connectionOutput.show();
		}
	}

	contextValue = 'connected-client';
	iconPath = new vscode.ThemeIcon('debug-console');
}