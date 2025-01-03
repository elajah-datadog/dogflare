import axios from 'axios';
import * as path from 'path';
import * as vscode from 'vscode';

// Load dotenv 
require('dotenv').config({ path: '/Users/elajah.gijsbertha/dogflare/.env' });

// Now you can access the variables from process.env
const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN;
const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL;
const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN;

// Search Zendesk users by email to find assignee id
export async function getAssigneeId(email: string): Promise<string | null> {
    // Encode the email to handle special characters
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/search.json?query=${encodeURIComponent(email)}`;

    try {
        const response = await axios.get(url, {
            headers: {
                // Zendesk uses Basic auth with the format: email/token:API_TOKEN
                'Authorization': `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;

        // Check if we got at least one user
        if (data.users && data.users.length > 0) {
            return data.users[0].id;
        } else {
            console.warn(`No user found for email: ${email}`);
            return null;
        }
    } catch (error: any) {
        console.error(`Error fetching assignee ID: ${error.message}`);
        return null;
    }
}

// Searh for all tickets assign to user
export async function getTicketsById(storedID: string): Promise<string[] | null> {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/users/${encodeURIComponent(storedID)}/tickets/assigned`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;

        // "tickets" is an array of ticket objects
        if (data.tickets && Array.isArray(data.tickets) && data.tickets.length > 0) {
            // Extract each ticket's ID
            const ticketIds = data.tickets
                .filter((ticket: any) => ticket.status !== 'solved')
                .map((ticket: any) => String(ticket.id));

            // Print to the Debug Console in VS Code
            // (Open the "Debug Console" panel after running your extension)
            console.log('Retrieved ticket IDs:', ticketIds);

            return ticketIds;
        } else {
            console.warn(`No tickets found for user ID: ${storedID}`);
            return null;
        }
    } catch (error: any) {
        console.error(`Error fetching tickets for user ID ${storedID}: ${error.message}`);
        return null;
    }
}

// Interface to hold information for attachments
export interface AttachmentInfo {
    url: string;        // The content_url (direct link to the file)
    createdAt: string;  // e.g. "2024-12-19T23:02:36Z"
    fileName: string;   // e.g. "logs.txt" or "image.png"
    id: string;         // The id of the attachment
  }

function appendCounterToFileName(fileName: string, counter: number): string {
    const ext = path.extname(fileName);
    const baseName = path.basename(fileName, ext);
    return `${baseName}(${counter})${ext}`;
}

// Fetch all attachments from ticket comments.
// Returns an array of { url, createdAt, fileName }, or null if none found.
export async function getAttachmentsByTicketId(ticketId: string): Promise<AttachmentInfo[] | null> {
    const url = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${encodeURIComponent(ticketId)}/comments.json`;

    try {
        const response = await axios.get(url, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        const data = response.data;
        if (data.comments && Array.isArray(data.comments)) {
            const allAttachments: AttachmentInfo[] = [];
            const fileNameCounts: { [fileName: string]: number } = {};

            // Collect attachments from each comment
            for (const comment of data.comments) {
                if (comment.attachments && Array.isArray(comment.attachments)) {
                    for (const attach of comment.attachments) {
                        let uniqueFileName = attach.file_name;
        
                        // Check if the filename already exists in the current batch
                        if (fileNameCounts[attach.file_name]) {
                            fileNameCounts[attach.file_name] += 1;
                            uniqueFileName = appendCounterToFileName(attach.file_name, fileNameCounts[attach.file_name]);
                        } else {
                            fileNameCounts[attach.file_name] = 1;
                        }
        
                        allAttachments.push({
                            url: attach.content_url,
                            createdAt: comment.created_at, 
                            fileName: uniqueFileName,
                            id: attach.id
                        });
                    }
                }
            }

            if (allAttachments.length > 0) {
                console.log(`Retrieved attachments for ticket ${ticketId}:`, allAttachments);
                return allAttachments;
            } else {
                console.warn(`No attachments found in comments for ticket ID: ${ticketId}`);
                return null;
            }
        } else {
            console.warn(`No comments found for ticket ID: ${ticketId}`);
            return null;
        }
    } catch (error: any) {
        console.error(`Error fetching attachments for ticket ${ticketId}: ${error.message}`);
        return null;
    }
}

export function createAuthenticatedAxios() {
    const auth = Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64');

    const instance = axios.create({
        headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
        },
    });

    return instance;
}

/**
 * Represents the status information of a ticket.
 */
export interface TicketStatus {
    id: number;
    status: string;
}

/**
 * Fetches the status of multiple tickets from Zendesk.
 * @param ticketIds Array of ticket IDs to fetch.
 * @returns Promise resolving to an array of TicketStatus objects.
 */
export async function fetchTicketsStatus(ticketIds: string | string[]): Promise<TicketStatus[]> {
    // Normalize ticketIds to an array
    const ticketIdsArray: string[] = typeof ticketIds === 'string' ? [ticketIds] : ticketIds;

    if (ticketIdsArray.length === 0) {
        throw new Error('No ticket IDs provided.');
    }

    const allTicketStatuses: TicketStatus[] = [];

    // Zendesk API may have a limit on the number of IDs per request. Adjust BATCH_SIZE accordingly.
    const BATCH_SIZE = 100; // Example batch size

    // Split ticketIdsArray into batches
    for (let i = 0; i < ticketIdsArray.length; i += BATCH_SIZE) {
        const batch = ticketIdsArray.slice(i, i + BATCH_SIZE);
        const idsParam = batch.join(',');

        // Encode the IDs parameter
        const encodedIds = encodeURIComponent(idsParam);

        // Construct the API URL
        const apiUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/show_many.json?ids=${encodedIds}`;

        try {
            // Make the API request
            const response = await axios.get(apiUrl, {
                headers: {
                    'Authorization': `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
                    'Content-Type': 'application/json'
                }
            });

            // Check for successful response
            if (response.status === 200) {
                const tickets = response.data.tickets;

                // Map each ticket to the TicketStatus interface
                const ticketStatuses: TicketStatus[] = tickets.map((ticket: any) => ({
                    id: ticket.id,
                    status: ticket.status,
                }));

                // Add to the aggregate list
                allTicketStatuses.push(...ticketStatuses);
            } else {
                console.error(`Failed to fetch tickets. HTTP Status: ${response.status}`);
                vscode.window.showErrorMessage(`Failed to fetch tickets. HTTP Status: ${response.status}`);
            }
        } catch (error: any) {
            // Handle errors (e.g., network issues, authentication failures)
            console.error(`Error fetching tickets:`, error);
            vscode.window.showErrorMessage(`Error fetching tickets: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return allTicketStatuses;
}