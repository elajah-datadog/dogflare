import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getAssigneeId, getTicketsById, getAttachmentsByTicketId } from './modules/apis';
import { createTicketsFolder, createFoldersForTicketIds, organizeAndDownloadAttachments } from './modules/functions';

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	const disposable = vscode.commands.registerCommand('dogflare.helloWorld', () => {

		const tickets = context.workspaceState.get<string>('lastListOfTickets');
		console.log(tickets);

		const email = context.workspaceState.get<string>('lastEmailUsed');
		console.log(email);

		const id = context.workspaceState.get<string>('lastIDUsed');
		console.log(id);

		const path = context.workspaceState.get<string>('lastFolderPath');
		console.log(path);
	});

	// Tree in sidepanel view 
	const treeDataProvider = new DogFlareTreeDataProvider(context);
    vscode.window.registerTreeDataProvider('dogflarePanel', treeDataProvider);


	// Commands to execute by labels
	const executeCommands = vscode.commands.registerCommand('dogflare.executeCommands', async (label: string) => {

		if (label === "Enter Email") {
		    // Register email and id for use in the c and store them inside vscode workspacestate for persistance
	        // also create inital folder "tickets" inside downloads file for use across the exntension
			const email = await vscode.window.showInputBox({ 
				prompt: "Enter the agent's email",
				placeHolder: "agent@example.com"
			});

			if (email) {
				// Call getAssigneeId with the provided email and fetch all data
				const assigneeId = await getAssigneeId(email);
				if (assigneeId) {
					vscode.window.showInformationMessage(`Assignee ID for ${email}: ${assigneeId}`);

					// Store the email and id in workspaceState
                    context.workspaceState.update('lastEmailUsed', email);
					context.workspaceState.update('lastIDUsed', assigneeId);

					// Create the tickets folder in ~/Downloads/tickets
					const folderPath = createTicketsFolder();
					context.workspaceState.update('lastFolderPath', folderPath);

					// Fetch Tickets and create folders
					const storedID = context.workspaceState.get<string>('lastIDUsed');
					if (!storedID) {
						vscode.window.showErrorMessage("No Assignee ID stored. Please 'Enter Email' first.");
						return;
					}
					const ticketIds = await getTicketsById(storedID);
					if (ticketIds && ticketIds.length > 0) {
						// Show ticket IDs in a user-friendly way
						vscode.window.showInformationMessage(`Ticket IDs: ${ticketIds.join(', ')}`);
						context.workspaceState.update('lastListOfTickets', ticketIds);
						createFoldersForTicketIds(ticketIds);
					} else {
						vscode.window.showErrorMessage("No tickets found or an error occurred.");
					}

					// Refresh the side panel so "Current User" updates immediately
                    treeDataProvider.refresh();
				} else {
					vscode.window.showErrorMessage(`No user found for ${email}`);
				}
			} else {
				vscode.window.showErrorMessage('Email input canceled or invalid.');
			}

	    // Get Tickets by ID
		} else if (label === "Fetch Tickets") {
            // The user wants to fetch all tickets for the stored ID
            const storedID = context.workspaceState.get<string>('lastIDUsed');
            if (!storedID) {
                vscode.window.showErrorMessage("No Assignee ID stored. Please 'Enter Email' first.");
                return;
            }
            const ticketIds = await getTicketsById(storedID);
            if (ticketIds && ticketIds.length > 0) {
                // Show ticket IDs in a user-friendly way
                vscode.window.showInformationMessage(`Ticket IDs: ${ticketIds.join(', ')}`);
				context.workspaceState.update('lastListOfTickets', ticketIds);
				createFoldersForTicketIds(ticketIds);
            } else {
                vscode.window.showErrorMessage("No tickets found or an error occurred.");
            }
		
		// Open Tickets Folder
		} else if (label === "Open Tickets") {

			const folderPath = path.join(os.homedir(), 'Downloads', 'tickets');
            if (!folderPath) {
                vscode.window.showErrorMessage("No Folder for Tickets: Please 'Enter Email' first.");
                return;
            }

			 // Open the folder in VS Code
			 vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), { forceNewWindow: false });
		} else if (label === "Fetch Attachments") {
			// Retrieve 'lastIDUsed' from workspaceState, or prompt user for a ticket ID
			const storedID = context.workspaceState.get<string>('lastIDUsed');
			if (!storedID) {
				vscode.window.showErrorMessage("No Assignee ID stored. Please 'Enter Email' first.");
				return;
			}
		
			// Or if you have a "Fetch Tickets" step that gave you a 'ticketId', you can do that.
			// For simplicity, let's prompt for the actual ticket ID:
			const ticketId = await vscode.window.showInputBox({ 
				prompt: "Enter the specific Ticket ID you want to download attachments for",
				placeHolder: "e.g. 22542"
			});
			if (!ticketId) {
				vscode.window.showErrorMessage("No Ticket ID provided.");
				return;
			}
		
			// 1. Retrieve attachments
			const attachments = await getAttachmentsByTicketId(ticketId);
			if (attachments && attachments.length > 0) {
				// 2. Organize them into date-based folders, then download
				await organizeAndDownloadAttachments(ticketId, attachments);
			} else {
				vscode.window.showInformationMessage("No attachments found for that ticket.");
			}
        } else {
			// Handle other items if needed
			vscode.window.showInformationMessage(`Executed command: ${label}`);
		}
	});

	context.subscriptions.push(disposable, executeCommands);
}

// List of buttons that show on the side pannel and current user
class DogFlareTreeDataProvider implements vscode.TreeDataProvider<TreeItem> {
    // For refreshing the view
    private _onDidChangeTreeData: vscode.EventEmitter<TreeItem | undefined | void> = new vscode.EventEmitter<TreeItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<TreeItem | undefined | void> = this._onDidChangeTreeData.event;

    // We store a reference to ExtensionContext so we can read workspaceState
    constructor(private context: vscode.ExtensionContext) {}

    // Call this method when you want to refresh the tree
    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    getChildren(element?: TreeItem): TreeItem[] {
        if (!element) {
            // Retrieve the email from workspaceState
            const email = this.context.workspaceState.get<string>('lastEmailUsed');
            const items: TreeItem[] = [];

			// Show "Current User: yourEmail@domain.com" at the top
			// If no email is stored, show a placeholder
            if (email) {
                const [user] = email.split('@');
				items.push(new TreeItem(`Current User: ${user}`));

            } else {
                items.push(new TreeItem("No email stored"));
            }

            // Add buttons here
            items.push(
                new TreeItem("Open Tickets"),
				new TreeItem(""),
				new TreeItem("Enter Email"),
                new TreeItem("Fetch Tickets"),
                new TreeItem("Fetch Attachments"),
                new TreeItem("Scrub Closed Tickets")
            );

            return items;
        }
        return [];
    }
}

// Commands for all the buttons in the list
class TreeItem extends vscode.TreeItem {
    constructor(label: string) {
        super(label);
        this.command = {
            command: 'dogflare.executeCommands',
            title: label,
            arguments: [label] // Pass the label as an argument
        };
    }
}

// This method is called when your extension is deactivated
export function deactivate() {}