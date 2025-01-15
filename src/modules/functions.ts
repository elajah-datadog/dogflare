import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import crypto from 'crypto';
import { createAuthenticatedAxios, getAttachmentsByTicketId, TicketStatus } from './apis';
const unzipper = require('unzipper');

// Function to compute SHA256 hash of a file
async function computeFileHash(filePath: string): Promise<string> {
    console.log("please work 2.5", filePath);
    return new Promise<string>((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('error', err => reject(err));
        stream.on('data', chunk => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

// Utility to ensure folder creation
function ensureFolderExists(folderPath: string) {
    fs.mkdirSync(folderPath, { recursive: true });
}

// Create main folder for tickets
export function createTicketsFolder() {
    const folderPath = path.join(os.homedir(), 'Downloads', 'tickets');
    try {
        // { recursive: true } ensures the command won't fail if the folder already exists
        fs.mkdirSync(folderPath, { recursive: true });
        vscode.window.showInformationMessage(`Tickets folder created/exists at: ${folderPath}`);

        // Open the folder in VS Code
        vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(folderPath), { forceNewWindow: false });

    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
    }
	return folderPath;
}

// Create individual folder for each ticket in ascending order
export function createFoldersForTicketIds(ticketIds: string[]) {
    // Sort ticket IDs numerically (ascending)
    ticketIds.sort((a, b) => parseInt(a) - parseInt(b));

    // The parent folder is ~/Downloads/tickets
    const parentFolderPath = path.join(os.homedir(), 'Downloads', 'tickets');

    try {
        // Ensure the parent folder exists
        fs.mkdirSync(parentFolderPath, { recursive: true });

        // Create a subfolder for each ticket ID
        for (const id of ticketIds) {
            const folderPath = path.join(parentFolderPath, id);
            fs.mkdirSync(folderPath, { recursive: true });
            console.log(`Created folder: ${folderPath}`);
        }
        vscode.window.showInformationMessage(`Created folders for tickets: ${ticketIds.join(', ')}`);
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to create ticket folders: ${error.message}`);
    }
}

// Interface to hold information for attachments
export interface AttachmentInfo {
    url: string;         // The content_url (direct link to the file)
    createdAt: string;   // e.g. "2024-12-19T23:02:36Z"
    fileName: string;    // e.g. "logs.txt" or "image.png"
    hash: string;        // Hash value of attachment
  }

// Interface ticket number and attachments connected to set ticket
export interface TicketData {
    attachments: AttachmentInfo[];
}

// Interface to hold all the data together
export interface WorkspaceData {
    [ticketId: string]: TicketData;
}

/**
 * Organizes attachments by created date (YYYY-MM-DD) under: ~/Downloads/tickets/{ticketId}/{dateFolder}/
 * Then downloads the file to that folder. While preventing dedup
 * 
 * @param ticketId - Ticket IDs to add.
 * @param attachments - Attachments to be saved for the given ticketID
 * @param existingHashes - A Set containing all existing hashes to check against.
 * @returns A promise that resolves to the savePath if the file is unique and saved, or null if skipped.
 */
export async function organizeAndDownloadAttachments(ticketId: string, attachments: AttachmentInfo[], existingHashes: Set<string>): Promise<AttachmentInfo[]> {
    // Root folder: ~/Downloads/tickets/<ticketId>
    const ticketFolder = path.join(os.homedir(), 'Downloads', 'tickets', ticketId);
    ensureFolderExists(ticketFolder);

    const successfulDownloads: AttachmentInfo[] = [];

    // Create an authenticated Axios instance once
    const axiosInstance = createAuthenticatedAxios();

    // For each attachment, parse date, create subfolder, download file
    for (const attach of attachments) {
        const date = attach.createdAt.split('T')[0]; // e.g. "2024-12-19"
        const dateFolderPath = path.join(ticketFolder, date);
        ensureFolderExists(dateFolderPath);

        // The final path to the file
        const filePath = path.join(dateFolderPath, attach.fileName);

        console.log(`Downloading attachment to ${filePath} from ${attach.url}`);

        try {
            // Download the file data with duplicate checking
            const savedPath = await downloadFile(attach.url, filePath, axiosInstance, existingHashes);

            if (savedPath) {
                console.log(`Saved attachment: ${savedPath}`);

                // Compute the hash of the downloaded file
                const computedHash = await computeFileHash(savedPath);
                console.log(`Computed hash for ${savedPath}: ${computedHash}`);

                // Update the attachment's hash
                const downloads: AttachmentInfo = {
                ...attach,
                hash: computedHash,         // Update the hash field
                };
                console.log("testtest 3", downloads);

                // Check if the file is a ZIP archive
                if (path.extname(savedPath).toLowerCase() === '.zip') {
                    await handleDuplicateZip(savedPath, dateFolderPath, attach.fileName);
                }

                // Add recently downloaded hash to list to prevent dedup and push the succesfull download
                existingHashes.add(computedHash);
                successfulDownloads.push(downloads);
            } else {
                console.log(`Skipped duplicate attachment: ${attach.fileName}`);
            }
        } catch (err: any) {
            console.error(`Failed to download attachment from ${attach.url}: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to download attachment from ${attach.url}: ${err.message}`);
        }
    }

    // Optionally, notify the user in VS Code
    if (attachments.length > 0) {
        vscode.window.showInformationMessage(`Downloaded ${successfulDownloads.length} out of ${attachments.length} attachments for ticket ${ticketId}.`);
    } else {
        vscode.window.showWarningMessage(`No attachments to download for ticket ${ticketId}.`);
    }

    return successfulDownloads; // Return the array of successfully downloaded attachments
}

/**
 * Downloads a file from the given URL and saves it to the specified path using streams.
 * Computes the SHA256 hash on-the-fly and skips writing if a duplicate is detected.
 * 
 * @param downloadUrl - The URL to download the file from.
 * @param savePath - The local path where the file will be saved.
 * @param axiosInstance - An authenticated Axios instance.
 * @param existingHashes - A Set containing all existing hashes to check against.
 * @returns A promise that resolves to the savePath if the file is unique and saved, or null if skipped.
 */
async function downloadFile(downloadUrl: string, savePath: string, axiosInstance: any, existingHashes: Set<string>): Promise<string | null> {
    console.log(`Initiating download from ${downloadUrl} to ${savePath}`);

    // Initialize hash computation
    const hash = crypto.createHash('sha256');

    // Create a writable stream to a temporary file
    const tempSavePath = `${savePath}.temp`;
    const writer = fs.createWriteStream(tempSavePath);

    return new Promise<string | null>((resolve, reject) => {
        axiosInstance.get(downloadUrl, { responseType: 'stream' })
            .then((response: any) => { // Explicitly type 'response' as AxiosResponse
                if (response.status !== 200) {
                    throw new Error(`Failed to download file. HTTP Status: ${response.status}`);
                }

                // Listen for data chunks to compute hash on-the-fly
                response.data.on('data', (chunk: Buffer) => {
                    hash.update(chunk);
                });

                // Pipe the response data to the temporary file
                response.data.pipe(writer);

                // Handle stream finish event
                writer.on('finish', () => {
                    const computedHash = hash.digest('hex');
                    console.log(`Computed hash for ${savePath}: ${computedHash}`);

                    if (existingHashes.has(computedHash)) {
                        console.log(`Duplicate detected for hash ${computedHash}. Skipping file.`);
                        // Delete the temporary file
                        fs.unlinkSync(tempSavePath);
                        vscode.window.showWarningMessage(`Duplicate attachment detected and skipped: ${path.basename(savePath)}`);
                        resolve(null); // Indicate that the file was skipped
                    } else {
                        // Rename the temp file to the final save path
                        fs.renameSync(tempSavePath, savePath);
                        console.log(`File saved successfully to ${savePath}`);
                        resolve(savePath); // Indicate successful save
                    }
                });

                // Handle write stream errors
                writer.on('error', (err: Error) => {
                    console.error(`Error writing file to ${tempSavePath}:`, err);
                    fs.unlinkSync(tempSavePath); // Clean up temp file
                    reject(err);
                });

                // Handle response data errors
                response.data.on('error', (err: Error) => {
                    console.error(`Error during download from ${downloadUrl}:`, err);
                    writer.close();
                    fs.unlinkSync(tempSavePath); // Clean up temp file
                    reject(err);
                });
            })
            .catch((err: Error) => { // Explicitly type 'err' as Error
                console.error(`Error downloading file from ${downloadUrl}:`, err);
                writer.close();
                fs.unlinkSync(tempSavePath); // Clean up temp file
                vscode.window.showErrorMessage(`Error downloading file: ${err.message}`);
                reject(err);
            });
    });
}

async function handleDuplicateZip(savePath: string, dateFolderPath: string, attachFileName: string): Promise<void> {
    console.log(`Detected ZIP file: ${savePath}. Attempting to unzip...`);
    try {
        // Open the ZIP file
        const directory = await unzipper.Open.file(savePath);

        // Determine the top-level folders in the ZIP
        const topLevelFolders = new Set<string>();
        directory.files.forEach((entry: { path: string; }) => {
            const firstSegment = entry.path.split('/')[0];
            if (firstSegment) {
                topLevelFolders.add(firstSegment);
            }
        });

        // If there's a single top-level folder, use its name as the extraction folder
        // Otherwise, create a unique folder based on the ZIP file name
        let extractionFolderName: string;
        if (topLevelFolders.size === 1) {
            extractionFolderName = Array.from(topLevelFolders)[0];
        } else {
            // Fallback: use the ZIP file name without extension
            extractionFolderName = path.basename(savePath, '.zip');
        }

        let extractionFolder = path.join(dateFolderPath, extractionFolderName);

        // Handle duplicate folder names by appending a numerical suffix
        if (fs.existsSync(extractionFolder)) {
            const parsed = path.parse(extractionFolder);
            let counter = 1;
            while (fs.existsSync(extractionFolder)) {
                extractionFolder = path.join(
                    parsed.dir,
                    `${parsed.name}(${counter})${parsed.ext}`
                );
                counter++;
            }
        }

        // Create the extraction folder
        await fs.promises.mkdir(extractionFolder, { recursive: true });
        //console.log(`Extracting ZIP to folder: ${extractionFolder}`);

        // Iterate through each entry in the ZIP
        for (const entry of directory.files) {


            // Initialize relativePath with the full entry path
            let relativePath = entry.path;

            if (topLevelFolders.size === 1) {
                // Remove the top-level folder from entry.path to prevent duplication
                const segments = relativePath.split('/').slice(1); // Remove the first segment
                relativePath = segments.join('/');
            }

            // If relativePath is empty, skip this entry (it was the top-level folder)
            if (relativePath === '') {
                continue;
            }

            // Construct the full path for the extracted file
            const entryPath = path.join(extractionFolder, relativePath);
            const entryDir = path.dirname(entryPath);

           // console.log("this is the entry path,", entry.path);
           // console.log("this is entryDir", entryDir);
           // console.log("this is entryPath", entryPath);

            // Ensure the directory for the current entry exists
            await fs.promises.mkdir(entryDir, { recursive: true });

            if (entry.type === 'Directory') {
                // If the entry is a directory, skip extraction (directories are handled by mkdir)
                continue;
            }

            let finalPath = entryPath;
           // console.log("this is final path", finalPath);

            // Extract the file to the final path
            await new Promise<void>((resolve, reject) => {
                entry.stream()
                    .pipe(fs.createWriteStream(finalPath))
                    .on('finish', () => {
                        console.log(`Extracted to ${finalPath}`);
                        resolve();
                    })
                    .on('error', (err: Error) => { // Explicitly type 'err' as Error
                        reject(err);
                    });
            });
        }

       // console.log(`Successfully unzipped ${savePath} into ${extractionFolder}`);

        // Delete the original ZIP file after successful extraction
        await fs.promises.unlink(savePath);
     //   console.log(`Deleted original ZIP file: ${savePath}`);

    } catch (zipError: unknown) { // Type as 'unknown' for better type safety
        let errorMessage = 'An unknown error occurred during ZIP extraction.';
        if (zipError instanceof Error) {
            errorMessage = zipError.message;
        }
        console.error(`Failed to unzip ${attachFileName}: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to unzip ${attachFileName}: ${errorMessage}`);
    }
}

/**
 * Adds multiple Ticket IDs to the existing list in workspaceState if they don't already exist.
 * 
 * @param context - The extension context.
 * @param ticketIds - An array of Ticket IDs to add.
 */
export async function addTicketIds( context: vscode.ExtensionContext, ticketsToAdd: { [ticketId: string]: AttachmentInfo[] } // Corrected type: Maps ticket ID to array of AttachmentInfo
): Promise<{ success: boolean; addedTickets: string[]; existingTickets: string[] }> {
    try {
        // Define the workspace data key
        const WORKSPACE_DATA_KEY = 'ticketData';

        // Retrieve existing workspace data or initialize as an empty object
        const workspaceData: WorkspaceData = context.workspaceState.get<WorkspaceData>(WORKSPACE_DATA_KEY) || {};

        const addedTickets: string[] = [];
        const existingTickets: string[] = [];

        for (const [ticketId, attachments] of Object.entries(ticketsToAdd)) {
            if (!workspaceData[ticketId]) {
                // Add new ticket with its attachments
                workspaceData[ticketId] = {
                    attachments: attachments
                };
                addedTickets.push(ticketId);
                console.log(`Added new ticket ID: ${ticketId} with ${attachments.length} attachments.`);
            } else {
                existingTickets.push(ticketId);
                console.log(`Ticket ID already exists: ${ticketId}`);
            }
        }

        // Update the workspaceState with the modified data
        const updateSuccess = await context.workspaceState.update(WORKSPACE_DATA_KEY, workspaceData);


            // Provide feedback for added tickets
            if (addedTickets.length > 0) {
                const addedMessage = addedTickets.length === 1
                    ? `Added Ticket ID "${addedTickets[0]}" with ${ticketsToAdd[addedTickets[0]].length} attachments.`
                    : `Added ${addedTickets.length} Ticket IDs with their attachments.`;
                vscode.window.showInformationMessage(addedMessage);
                console.log(`Successfully added Ticket IDs: ${addedTickets.join(', ')}.`);
            }

            // Provide feedback for existing tickets
            if (existingTickets.length > 0) {
                const existingMessage = existingTickets.length === 1
                    ? `Ticket ID "${existingTickets[0]}" is already in the list.`
                    : `${existingTickets.length} Ticket IDs are already in the list: ${existingTickets.join(', ')}.`;
                vscode.window.showInformationMessage(existingMessage);
                console.log(`Ticket IDs already in the list: ${existingTickets.join(', ')}.`);
            }

            return {
                success: true,
                addedTickets,
                existingTickets
            };
    } catch (error) {
        // Handle unexpected errors
        console.error(`Error adding Ticket IDs:`, error);
        vscode.window.showErrorMessage(`Error adding Ticket IDs: ${error instanceof Error ? error.message : String(error)}`);
        return {
            success: false,
            addedTickets: [],
            existingTickets: []
        };
    }
}

/**
 * Removes specified Ticket IDs from the workspace data and deletes their corresponding folders.
 * 
 * @param context - The extension context.
 * @param ticketIds - A single Ticket ID or an array of Ticket IDs to remove.
 */
export async function removeTicketIds(context: vscode.ExtensionContext, ticketIds: string | string[]): Promise<void> {
    try {
        // Normalize ticketIds to an array
        const ticketIdsArray: string[] = typeof ticketIds === 'string' ? [ticketIds] : ticketIds;

        // Define the workspace data key
        const WORKSPACE_DATA_KEY = 'ticketData';

        // Retrieve existing workspace data or initialize as an empty object
        const workspaceData: WorkspaceData = context.workspaceState.get<WorkspaceData>(WORKSPACE_DATA_KEY) || {};

        // Arrays to track the status of each ticket removal
        const removedTickets: string[] = [];
        const nonExistentTickets: string[] = [];
        const failedDeletions: { ticketId: string; error: string }[] = [];

        for (const ticketId of ticketIdsArray) {
            if (workspaceData[ticketId]) {
                // Remove the ticket data from workspaceData
                delete workspaceData[ticketId];
                removedTickets.push(ticketId);
                console.log(`Removed Ticket ID "${ticketId}" from workspace data.`);

                // Define the path to the ticket folder
                const ticketFolderPath = path.join(os.homedir(), 'Downloads', 'tickets', ticketId);

                // Check if the folder exists before attempting to delete
                if (fs.existsSync(ticketFolderPath)) {
                    try {
                        // Recursively delete the folder and its contents
                        await fs.promises.rm(ticketFolderPath, { recursive: true, force: true });
                        console.log(`Deleted folder: ${ticketFolderPath}`);
                    } catch (deleteError: any) {
                        console.error(`Failed to delete folder ${ticketFolderPath}:`, deleteError);
                        failedDeletions.push({
                            ticketId,
                            error: deleteError instanceof Error ? deleteError.message : String(deleteError)
                        });
                        vscode.window.showErrorMessage(`Failed to delete folder for Ticket ID "${ticketId}": ${deleteError instanceof Error ? deleteError.message : String(deleteError)}`);
                    }
                } else {
                    console.log(`Folder does not exist for Ticket ID "${ticketId}": ${ticketFolderPath}`);
                }
            } else {
                nonExistentTickets.push(ticketId);
                console.log(`Ticket ID "${ticketId}" does not exist in workspace data.`);
            }
        }

        // Update the workspaceState with the modified data
        await context.workspaceState.update(WORKSPACE_DATA_KEY, workspaceData);

        // Provide feedback for removed tickets
        if (removedTickets.length > 0) {
            const removedMessage = removedTickets.length === 1
                ? `Removed Ticket ID "${removedTickets[0]}" and deleted its folder.`
                : `Removed ${removedTickets.length} Ticket IDs and deleted their folders: ${removedTickets.join(', ')}.`;
            vscode.window.showInformationMessage(removedMessage);
            console.log(removedMessage);
        }

        // Provide feedback for non-existent tickets
        if (nonExistentTickets.length > 0) {
            const nonExistentMessage = nonExistentTickets.length === 1
                ? `Ticket ID "${nonExistentTickets[0]}" was not found in workspace data.`
                : `${nonExistentTickets.length} Ticket IDs were not found in workspace data: ${nonExistentTickets.join(', ')}.`;
            vscode.window.showWarningMessage(nonExistentMessage);
            console.log(nonExistentMessage);
        }

        // Provide feedback for failed deletions
        if (failedDeletions.length > 0) {
            failedDeletions.forEach(({ ticketId, error }) => {
                const failureMessage = `Failed to delete folder for Ticket ID "${ticketId}": ${error}`;
                vscode.window.showErrorMessage(failureMessage);
                console.log(failureMessage);
            });
        }

        // Handle the case where no tickets were removed
        if (removedTickets.length === 0 && nonExistentTickets.length === 0) {
            vscode.window.showInformationMessage('No Ticket IDs were removed.');
            console.log('No Ticket IDs were removed.');
        }
    } catch (error: any) {
        // Handle unexpected errors
        console.error(`Error removing Ticket IDs ${Array.isArray(ticketIds) ? ticketIds.join(', ') : ticketIds}:`, error);
        vscode.window.showErrorMessage(`Error removing Ticket IDs: ${error instanceof Error ? error.message : String(error)}`);
    }
}

// Receive single ticket id or array of ticket ids
// Calls api to get attacthments from tickets
export async function processTickets(context: vscode.ExtensionContext, ticketIds: string | string[] ): Promise<void> {
    // Normalize ticketIds to an array
    const tickets = Array.isArray(ticketIds) ? ticketIds : [ticketIds];

    // Object to map ticket IDs to their successful downloads
    const ticketsToAdd: { [ticketId: string]: AttachmentInfo[] } = {};

        // Retrieve existing hashes from workspaceData
        const WORKSPACE_DATA_KEY = 'ticketData';
        const workspaceData: WorkspaceData = context.workspaceState.get<WorkspaceData>(WORKSPACE_DATA_KEY) || {};
    
        const existingHashes = new Set<string>();
        for (const ticket of Object.values(workspaceData)) {
            for (const attachment of ticket.attachments) {
                existingHashes.add(attachment.hash);
            }
        }

    for (const ticketId of tickets) {
        try {
            // 1. Retrieve attachments (ensure getAttachmentsByTicketId is defined and imported)
            const attachments = await getAttachmentsByTicketId(ticketId);

            if (attachments && attachments.length > 0) {
                // 2. Organize them into date-based folders, then download
                console.log("Attachments:", attachments);
                const successfulDownloads = await organizeAndDownloadAttachments(ticketId, attachments, existingHashes);
                console.log("testtest 4", successfulDownloads);
                if (successfulDownloads.length > 0) {
                    // 3. Map the successful downloads to the ticket ID
                    ticketsToAdd[ticketId] = successfulDownloads;
                    console.log(`Successfully processed ticket ID: ${ticketId} with ${successfulDownloads.length} attachments.`);
                } else {
                    vscode.window.showWarningMessage(`No attachments were successfully downloaded for ticket ${ticketId}.`);
                    console.log(`No attachments were successfully downloaded for ticket ${ticketId}.`);
                }
            } else {
                vscode.window.showInformationMessage(`No attachments found for ticket ${ticketId}.`);
                console.log(`No attachments found for ticket ${ticketId}.`);
            }
        } catch (error) {
            console.error(`Error processing ticket ID ${ticketId}:`, error);
            vscode.window.showErrorMessage(`Error processing ticket ID ${ticketId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // 4. Add the collected tickets and their attachments to the workspace
    const ticketIdsAdded = Object.keys(ticketsToAdd);
    if (ticketIdsAdded.length > 0) {
        const result = await addTicketIds(context, ticketsToAdd);
        if (result.success) {
            vscode.window.showInformationMessage(`Successfully added ${result.addedTickets.length} new ticket(s).`);
            if (result.existingTickets.length > 0) {
                vscode.window.showInformationMessage(`${result.existingTickets.length} ticket(s) already existed.`);
            }
        } else {
            vscode.window.showErrorMessage('Failed to add some or all tickets to the workspace.');
        }
    } else {
        vscode.window.showInformationMessage('No new tickets were added to the workspace.');
    }
}

/**
 * Removes all tickets with a status of "closed" by deleting their corresponding folders
 * and updating the workspace state.
 * 
 * @param context - The extension context.
 * @param ticketStatuses - An array of TicketStatus objects.
 */
export async function removeClosedTickets(context: vscode.ExtensionContext, ticketStatuses: TicketStatus[]): Promise<void> {
    try {
        // Step 1: Filter tickets with status "closed" (case-insensitive)
        const closedTickets = ticketStatuses.filter(ticket => ticket.status.toLowerCase() === 'solved');

        if (closedTickets.length === 0) {
            vscode.window.showInformationMessage('There are no solved tickets to remove.');
            return;
        }

        // Step 2: Extract ticket IDs from the closed tickets
        const closedTicketIds = closedTickets.map(ticket => String(ticket.id));

        // Step 3: Remove the closed ticket IDs using the existing removeTicketIds function
        await removeTicketIds(context, closedTicketIds);

        // Step 4: Provide additional feedback if needed
        if (closedTicketIds.length > 0) {
            const message = closedTicketIds.length === 1
                ? `Removed closed Ticket ID "${closedTicketIds[0]}".`
                : `Removed ${closedTicketIds.length} closed Ticket IDs: ${closedTicketIds.join(', ')}.`;
            vscode.window.showInformationMessage(message);
            console.log(message);
        }
    } catch (error) {
        // Handle any unexpected errors
        console.error('Error removing closed tickets:', error);
        vscode.window.showErrorMessage(`Error removing closed tickets: ${error instanceof Error ? error.message : String(error)}`);
    }
}