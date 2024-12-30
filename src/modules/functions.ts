import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { createAuthenticatedAxios } from './apis';
import axios from 'axios';
const unzipper = require('unzipper');



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
    url: string;        // The content_url (direct link to the file)
    createdAt: string;  // e.g. "2024-12-19T23:02:36Z"
    fileName: string;   // e.g. "logs.txt" or "image.png"
  }

// Organizes attachments by created date (YYYY-MM-DD) under:
// ~/Downloads/tickets/{ticketId}/{dateFolder}/
// Then downloads the file to that folder.
export async function organizeAndDownloadAttachments(ticketId: string, attachments: AttachmentInfo[]) {
    // Root folder: ~/Downloads/tickets/<ticketId>
    const ticketFolder = path.join(os.homedir(), 'Downloads', 'tickets', ticketId);
    ensureFolderExists(ticketFolder);

    // For each attachment, parse date, create subfolder, download file
    for (const attach of attachments) {
        const date = attach.createdAt.split('T')[0]; // e.g. "2024-12-19"
        const dateFolderPath = path.join(ticketFolder, date);
        ensureFolderExists(dateFolderPath);

        // The final path to the file
        const filePath = path.join(dateFolderPath, attach.fileName);

        console.log(`Downloading attachment to ${filePath} from ${attach.url}`);

        try {
            // Download the file data
            const token = createAuthenticatedAxios();
            const savePath = await downloadFile(attach.url, filePath, token);

            console.log(`Saved attachment: ${savePath}`);
            
            // Check if the file is a ZIP archive
            if (path.extname(savePath).toLowerCase() === '.zip') {
                await handleDuplicateZip(savePath, dateFolderPath, attach.fileName);
            }

        } catch (err: any) {
            console.error(`Failed to download attachment from ${attach.url}: ${err.message}`);
            vscode.window.showErrorMessage(`Failed to download attachment from ${attach.url}: ${err.message}`);
        }
    }

    // Optionally, notify the user in VS Code
    if (attachments.length > 0) {
        vscode.window.showInformationMessage(`Downloaded ${attachments.length} attachments for ticket ${ticketId}.`);
    } else {
        vscode.window.showWarningMessage(`No attachments to download for ticket ${ticketId}.`);
    }
}

async function downloadFile(downloadUrl: string, savePath: string, axiosInstance: any): Promise<string> {
    try {
        const response = await axiosInstance.get(downloadUrl, { responseType: 'arraybuffer' });

        if (response.status !== 200) {
            throw new Error(`Failed to download file. HTTP Status: ${response.status}`);
        }

        // Save the file to disk
        fs.writeFileSync(savePath, response.data);
        console.log(`Attachment saved to ${savePath}`);
    } catch (error: any) {
        console.error(`Error downloading file from ${downloadUrl}: ${error.message}`);
        vscode.window.showErrorMessage(`Error downloading file: ${error.message}`);
        throw error;
    }

    return savePath;
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
        console.log(`Extracting ZIP to folder: ${extractionFolder}`);

        // Iterate through each entry in the ZIP
        for (const entry of directory.files) {
            console.log("this is the entry path,", entry.path);
            const entryPath = path.join(extractionFolder, entry.path);
            const entryDir = path.dirname(entryPath);
            console.log("this is entryDir", entryDir);
            console.log("this is entryPath", entryPath);

            // Ensure the directory for the current entry exists
            await fs.promises.mkdir(entryDir, { recursive: true });

            if (entry.type === 'Directory') {
                // If the entry is a directory, skip extraction (directories are handled by mkdir)
                continue;
            }

            let finalPath = entryPath;
            console.log("this is final path", finalPath);

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

        console.log(`Successfully unzipped ${savePath} into ${extractionFolder}`);

        // Delete the original ZIP file after successful extraction
        await fs.promises.unlink(savePath);
        console.log(`Deleted original ZIP file: ${savePath}`);

    } catch (zipError: unknown) { // Type as 'unknown' for better type safety
        let errorMessage = 'An unknown error occurred during ZIP extraction.';
        if (zipError instanceof Error) {
            errorMessage = zipError.message;
        }
        console.error(`Failed to unzip ${attachFileName}: ${errorMessage}`);
        vscode.window.showErrorMessage(`Failed to unzip ${attachFileName}: ${errorMessage}`);
    }
}
