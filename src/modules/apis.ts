import axios from 'axios';
import * as path from 'path';
import * as vscode from 'vscode';
import { AttachmentInfo } from './functions';

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
            // Extract each ticket's ID except tickets that are solved or closed
            const ticketIds = data.tickets
                .filter((ticket: any) => ticket.status !== 'solved' && ticket.status !== 'closed')
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

// Fetch all attachments from ticket comments.
// Returns an array of { url, createdAt, fileName }, or null if none found.
export async function getAttachmentsByTicketId(ticketId: string): Promise<AttachmentInfo[] | null> {
    // Define your Zendesk credentials and subdomain
    const ZENDESK_SUBDOMAIN = process.env.ZENDESK_SUBDOMAIN!;
    const ZENDESK_EMAIL = process.env.ZENDESK_EMAIL!;
    const ZENDESK_API_TOKEN = process.env.ZENDESK_API_TOKEN!;

    const apiUrl = `https://${ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/${ticketId}/comments.json`; // Example endpoint

    try {
        const response = await axios.get(apiUrl, {
            headers: {
                'Authorization': `Basic ${Buffer.from(`${ZENDESK_EMAIL}/token:${ZENDESK_API_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.status === 200) {
            const comments = response.data.comments;
            const attachments: AttachmentInfo[] = [];

            for (const comment of comments) {
                if (comment.attachments && comment.attachments.length > 0) {
                    for (const attachment of comment.attachments) {
                        attachments.push({
                            fileName: attachment.file_name,
                            url: attachment.content_url,
                            createdAt: comment.created_at,
                            hash: ''
                        });
                    }
                }
            }

            return attachments;
        } else {
            vscode.window.showErrorMessage(`Failed to retrieve attachments for Ticket ID "${ticketId}". HTTP Status: ${response.status}`);
            console.error(`Failed to retrieve attachments for Ticket ID "${ticketId}". HTTP Status: ${response.status}`);
            return null;
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Error retrieving attachments for Ticket ID "${ticketId}": ${error instanceof Error ? error.message : String(error)}`);
        console.error(`Error retrieving attachments for Ticket ID "${ticketId}":`, error);
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