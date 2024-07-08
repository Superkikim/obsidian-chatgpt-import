// Imports
import { Plugin, PluginSettingTab, Setting, TFile, TFolder, Modal, Notice, moment } from 'obsidian';
import JSZip from 'jszip';
import { PluginSettings, ChatMessage, Chat, ConversationRecord } from './types';
import { formatTimestamp, getYearMonthFolder, formatTitle, isValidMessage } from './utils';

// Constants
const DEFAULT_SETTINGS: PluginSettings = {
    archiveFolder: 'ChatGPT Archives',
    addDatePrefix: false,
    dateFormat: 'YYYY-MM-DD'
};

enum LogLevel {
    INFO,
    WARN,
    ERROR
}

class Logger {
    private logToConsole(level: LogLevel, message: string, details?: any) {
        const timestamp = new Date().toISOString();
        const logMethod = level === LogLevel.ERROR ? console.error : 
                          level === LogLevel.WARN ? console.warn : 
                          console.log;
        
        logMethod(`[${timestamp}] [ChatGPT Import] [${LogLevel[level]}] ${message}`, details);
    }

    info(message: string, details?: any) {
        this.logToConsole(LogLevel.INFO, message, details);
    }

    warn(message: string, details?: any) {
        this.logToConsole(LogLevel.WARN, message, details);
    }

    error(message: string, details?: any) {
        this.logToConsole(LogLevel.ERROR, message, details);
    }
}

export default class ChatGPTImportPlugin extends Plugin {
    // Properties
    settings: PluginSettings;
    private importLog: ImportLog;
    private importedArchives: Record<string, string> = {}; // hash -> filename
    private conversationRecords: Record<string, { path: string, updateTime: number }> = {};
    /**
     * Source Counters
     */
    totalExistingConversations: number = 0; // Count of all existing conversations in Obsidian
    totalNewConversationsToImport: number = 0; // Count of new conversations to import
    totalNonEmptyMessagesToImport: number = 0; // Count of non-empty messages in new conversations to import
    totalNonEmptyMessagesToAdd: number = 0; // Count of non-empty messages to be added to existing conversations
    totalExistingConversationsToUpdate: number = 0; // Count of existing conversations identified to be updated

    /**
     * Processed Counters
     */
    totalNewConversationsSuccessfullyImported: number = 0; // Count of new conversations successfully imported
    totalConversationsActuallyUpdated: number = 0; // Count of conversations actually updated after processing
    totalNonEmptyMessagesAdded: number = 0; // Count of non-empty messages actually added to conversations
    
    // Lifecycle methods
    async onload() {
        console.log('Loading ChatGPT Import Plugin');
        this.logger = new Logger();
        await this.loadSettings();
    
        this.addSettingTab(new ChatGPTImportPluginSettingTab(this.app, this));
    
        this.addRibbonIcon('message-square-plus', 'Import ChatGPT ZIP', (evt: MouseEvent) => {
            this.selectZipFile();
        });

        this.registerEvent(this.app.vault.on('delete', (file) => {
            if (file instanceof TFile && file.extension === 'md') {
                // Remove the file from conversationRecords if it exists
                for (const [id, record] of Object.entries(this.conversationRecords)) {
                    if (record.path === file.path) {
                        delete this.conversationRecords[id];
                        this.saveSettings();
                        break;
                    }
                }
            }
        }));
        
        this.addCommand({
            id: 'import-chatgpt-zip',
            name: 'Import ChatGPT ZIP',
            callback: () => {
                this.selectZipFile();
            }
        });

        this.addCommand({
            id: 'reset-chatgpt-import-catalogs',
            name: 'Reset ChatGPT Import Catalogs',
            callback: () => {
                const modal = new Modal(this.app);
                modal.contentEl.createEl('p', {text: 'This will reset all import catalogs. This action cannot be undone.'});
                const buttonDiv = modal.contentEl.createEl('div', {cls: 'modal-button-container'});
                buttonDiv.createEl('button', {text: 'Cancel'}).addEventListener('click', () => modal.close());
                buttonDiv.createEl('button', {text: 'Reset', cls: 'mod-warning'}).addEventListener('click', () => {
                    this.resetCatalogs();
                    modal.close();
                });
                modal.open();
            }
        });
    }
    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings || {});
        this.importedArchives = data?.importedArchives || {};
        this.conversationRecords = data?.conversationRecords || {};
    }
    async saveSettings() {
        await this.saveData({
            settings: this.settings,
            importedArchives: this.importedArchives,
            conversationRecords: this.conversationRecords
        });
    }

    // Core functionality methods
    async handleZipFile(file: File) {
        this.importLog = new ImportLog();
        try {
            const fileHash = await this.getFileHash(file);
            if (this.importedArchives[fileHash]) {
                const shouldReimport = await this.showConfirmationDialog(
                    `This archive (${file.name}) has already been imported on ${this.importedArchives[fileHash].date}. Do you want to process it again?`
                );
                if (!shouldReimport) {
                    this.logInfo("Import cancelled by user", { fileName: file.name });
                    new Notice("Import cancelled.");
                    return;
                }
            }
    
            const zip = await this.validateZipFile(file);
            await this.processConversations(zip, file);
    
            this.importedArchives[fileHash] = {
                fileName: file.name,
                date: new Date().toISOString()
            };
            await this.saveSettings();
            
            this.logInfo("Import completed successfully", { fileName: file.name });
        } catch (error) {
            this.logError("Error handling zip file", error.message);
        } finally {
            await this.writeImportLog(file.name);
            new Notice(this.importLog.hasErrors() 
                ? "An error occurred during import. Please check the log file for details."
                : "Import completed. Log file created in the archive folder.");
        }
    }
    async processConversations(zip: JSZip, file: File): Promise<void> {
        try {
            const chats = await this.extractChatsFromZip(zip);
            this.logInfo(`Extracted ${chats.length} chats from zip file`, { fileName: file.name });
                const existingConversations = await this.getAllExistingConversations();
    
            this.initializeCounters(existingConversations);
    
            for (const chat of chats) {
                await this.processSingleChat(chat, existingConversations);
            }
    
            this.updateImportLog();

            this.logInfo(`Processed ${chats.length} conversations`, {
                new: this.totalNewConversationsSuccessfullyImported,
                updated: this.totalConversationsActuallyUpdated,
                skipped: this.totalExistingConversations - this.totalConversationsActuallyUpdated
            });
    
        } catch (error) {
            this.logError("Error processing conversations", error.message);
        }
    }
    async updateExistingNote(chat: Chat, filePath: string): Promise<void> {
        try {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.app.vault.process(file, (content) => {
                    const existingMessageIds = this.extractMessageUIDsFromNote(content);
                    const newMessages = this.getNewMessages(chat, existingMessageIds);
                    
                    // Update metadata
                    content = this.updateMetadata(content, chat.update_time);
                    
                    // Append new messages
                    content += this.formatNewMessages(newMessages);
                    
                    this.totalConversationsActuallyUpdated++;
                    this.totalNonEmptyMessagesAdded += newMessages.length;
                    
                    return content;
                });
    
                this.importLog.addUpdated(
                    chat.title || 'Untitled',
                    filePath,
                    `${formatTimestamp(chat.create_time, 'date')} ${formatTimestamp(chat.create_time, 'time')}`,
                    `${formatTimestamp(chat.update_time, 'date')} ${formatTimestamp(chat.update_time, 'time')}`
                );
            }
        } catch (error) {
            this.logError("Error updating existing note", error.message);
            this.importLog.addFailed(chat.title || 'Untitled', filePath,
                formatTimestamp(chat.create_time, 'date') + ' ' + formatTimestamp(chat.create_time, 'time'),
                formatTimestamp(chat.update_time, 'date') + ' ' + formatTimestamp(chat.update_time, 'time'),
                error.message
            );
        }
    }
    async createNewNote(chat: Chat, folderPath: string, existingConversations: Record<string, string>): Promise<void> {
        try {
            const fileName = await this.getUniqueFileName(chat, folderPath, existingConversations);
            const filePath = `${folderPath}/${fileName}`;
            const content = this.generateMarkdownContent(chat);
            await this.writeToFile(filePath, content);
            this.importLog.addCreated(
                chat.title || 'Untitled',
                filePath,
                `${formatTimestamp(chat.create_time, 'date')} ${formatTimestamp(chat.create_time, 'time')}`,
                `${formatTimestamp(chat.update_time, 'date')} ${formatTimestamp(chat.update_time, 'time')}`
            );
            this.totalNewConversationsSuccessfullyImported++;
            this.totalNonEmptyMessagesToImport += Object.values(chat.mapping).filter(msg => isValidMessage(msg)).length;
        
        } catch (error) {
            this.logError("Error creating new note", error.message);
            this.importLog.addFailed(chat.title || 'Untitled', filePath, 
                formatTimestamp(chat.create_time, 'date') + ' ' + formatTimestamp(chat.create_time, 'time'),
                formatTimestamp(chat.update_time, 'date') + ' ' + formatTimestamp(chat.update_time, 'time'),
                error.message
            );
            throw error;
        }
    }

    // Helper methods
    private async extractChatsFromZip(zip: JSZip): Promise<Chat[]> {
        const conversationsJson = await zip.file('conversations.json').async('string');
        return JSON.parse(conversationsJson);
    }

    private initializeCounters(existingConversations: Record<string, string>): void {
        this.totalExistingConversations = Object.keys(existingConversations).length;
        this.totalNewConversationsToImport = 0;
        this.totalExistingConversationsToUpdate = 0;
        this.totalNewConversationsSuccessfullyImported = 0;
        this.totalConversationsActuallyUpdated = 0;
        this.totalNonEmptyMessagesToImport = 0;
        this.totalNonEmptyMessagesToAdd = 0;
        this.totalNonEmptyMessagesAdded = 0;
    }

    private async processSingleChat(chat: Chat, existingConversations: Record<string, string>): Promise<void> {
        try {
            const folderPath = await this.createFolderForChat(chat);
            const existingRecord = this.conversationRecords[chat.id];
    
            if (existingRecord) {
                await this.handleExistingChat(chat, existingRecord, folderPath);
            } else {
                await this.handleNewChat(chat, folderPath, existingConversations);
            }
    
            this.updateConversationRecord(chat, folderPath);
        } catch (chatError) {
            this.logError(`Error processing chat: ${chat.title || 'Untitled'}`, chatError.message);
        }
    }
    
    private async createFolderForChat(chat: Chat): Promise<string> {
        const yearMonthFolder = getYearMonthFolder(chat.create_time);
        const folderPath = `${this.settings.archiveFolder}/${yearMonthFolder}`;
        const folderResult = await this.ensureFolderExists(folderPath);
        
        if (!folderResult.success) {
            throw new Error(`Failed to create or access folder: ${folderPath}. ${folderResult.error}`);
        }
    
        return folderPath;
    }
    
    private async handleExistingChat(chat: Chat, existingRecord: ConversationRecord, folderPath: string): Promise<void> {
        if (existingRecord.updateTime >= chat.update_time) {
            this.importLog.addSkipped(chat.title || 'Untitled', existingRecord.path, 
                formatTimestamp(chat.create_time, 'date'), 
                formatTimestamp(chat.update_time, 'date'), 
                "No Updates");
        } else {
            this.totalExistingConversationsToUpdate++;
            await this.updateExistingNote(chat, existingRecord.path);
        }
    }
    
    private async handleNewChat(chat: Chat, folderPath: string, existingConversations: Record<string, string>): Promise<void> {
        this.totalNewConversationsToImport++;
        await this.createNewNote(chat, folderPath, existingConversations);
    }
    
    private updateConversationRecord(chat: Chat, folderPath: string): void {
        this.conversationRecords[chat.id] = {
            path: `${folderPath}/${this.getFileName(chat)}`,
            updateTime: chat.update_time
        };
    }
    
    private updateImportLog(): void {
        this.importLog.addSummary(
            this.totalExistingConversations,
            this.totalNewConversationsSuccessfullyImported,
            this.totalConversationsActuallyUpdated,
            this.totalNonEmptyMessagesAdded
        );
    }

    updateMetadata(content: string, updateTime: number): string {
        const updateTimeStr = `${formatTimestamp(updateTime, 'date')} at ${formatTimestamp(updateTime, 'time')}`;
        
        // Update parameters
        content = content.replace(
            /^update_time: .*$/m,
            `update_time: ${updateTimeStr}`
        );
        
        // Update header
        content = content.replace(
            /^Last Updated: .*$/m,
            `Last Updated: ${updateTimeStr}`
        );
        
        return content;
    }

    getNewMessages(chat: any, existingMessageIds: string[]): ChatMessage[] {
        return Object.values(chat.mapping)
            .filter(message => 
                message && message.id && 
                !existingMessageIds.includes(message.id) &&
                isValidMessage(message)
            );
    }  

    formatNewMessages(messages: ChatMessage[]): string {
        return messages
            .filter(message => message !== undefined)
            .map(message => this.formatMessage(message))
            .filter(formattedMessage => formattedMessage !== '')
            .join('\n\n');
    }

    getFileName(chat: any): string {
        let fileName = formatTitle(chat.title);
        if (this.settings.addDatePrefix) {
            const createTimeStr = formatTimestamp(chat.create_time, 'prefix');
            fileName = `${createTimeStr} - ${fileName}`;
        }
        return `${fileName}.md`;
    }

    generateMarkdownContent(chat: any): string {
        const formattedTitle = formatTitle(chat.title);
        const create_time_str = `${formatTimestamp(chat.create_time, 'date')} at ${formatTimestamp(chat.create_time, 'time')}`;
        const update_time_str = `${formatTimestamp(chat.update_time, 'date')} at ${formatTimestamp(chat.update_time, 'time')}`;
    
        let content = this.generateHeader(formattedTitle, chat.id, create_time_str, update_time_str);
        content += this.generateMessagesContent(chat);
    
        return content;
    }

    async getFileHash(file: File): Promise<string> {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    async ensureFolderExists(folderPath: string): Promise<{ success: boolean, error?: string }> {
        const folders = folderPath.split("/").filter(p => p.length);
        let currentPath = "";
    
        for (const folder of folders) {
            currentPath += folder + "/";
            const currentFolder = this.app.vault.getAbstractFileByPath(currentPath);
            
            if (!currentFolder) {
                try {
                    await this.app.vault.createFolder(currentPath);
                } catch (error) {
                    if (error.message !== "Folder already exists.") {
                        this.logError(`Failed to create folder: ${currentPath}`, error.message);
                        return { success: false, error: `Failed to create folder: ${currentPath}. Reason: ${error.message}` };
                    }
                    // If folder already exists, continue silently
                }
            } else if (!(currentFolder instanceof TFolder)) {
                return { success: false, error: `Path exists but is not a folder: ${currentPath}` };
            }
        }
        return { success: true };
    }

    async getUniqueFileName(chat, folderPath, existingConversations) {
        let fileName = this.getFileName(chat);
        let counter = 1;
        let potentialFileName = fileName;
    
        while (Object.values(existingConversations).some(existingFile => 
            existingFile.includes(folderPath) && existingFile.endsWith(potentialFileName)
        )) {
            const nameWithoutExtension = fileName.slice(0, -3); // remove .md
            potentialFileName = `${nameWithoutExtension} (${counter}).md`;
            counter++;
        }
    
        return potentialFileName;
    }
    
    generateHeader(title, conversationId, createTimeStr, updateTimeStr) {
        return `---
aliases: ${title}
conversation_id: ${conversationId}
create_time: ${createTimeStr}
update_time: ${updateTimeStr}
---

# Topic: ${title}
Created: ${createTimeStr}
Last Updated: ${updateTimeStr}\n\n
`;
    }

    generateMessagesContent(chat) {
        let messagesContent = '';
        for (const messageId in chat.mapping) {
            const messageObj = chat.mapping[messageId];
            if (messageObj && messageObj.message && isValidMessage(messageObj.message)) {
                messagesContent += this.formatMessage(messageObj.message);
            }
        }
        return messagesContent;
    }
    
    formatMessage(message: ChatMessage): string {
        if (!message || typeof message !== 'object') {
            console.error('Invalid message object:', message);
            return ''; // Return empty string for invalid messages
        }
    
        const messageTime = formatTimestamp(message.create_time || Date.now() / 1000, 'date') + ' at ' + formatTimestamp(message.create_time || Date.now() / 1000, 'time');
        
        let authorName = "Unknown";
        if (message.author && typeof message.author === 'object' && 'role' in message.author) {
            authorName = message.author.role === 'user' ? "User" : "ChatGPT";
        } else {
            console.warn('Author information missing or invalid:', message.author);
        }
    
        const headingLevel = authorName === "User" ? "###" : "####";
        const quoteChar = authorName === "User" ? ">" : ">>";
    
        let messageContent = `${headingLevel} ${authorName}, on ${messageTime};\n`;
        
        if (
            message.content &&
            typeof message.content === 'object' &&
            Array.isArray(message.content.parts) &&
            message.content.parts.length > 0
        ) {
            const messageText = message.content.parts
                .filter(part => typeof part === 'string')
                .join('\n');
            messageContent += messageText.split('\n').map(line => `${quoteChar} ${line}`).join('\n');
        } else {
            console.warn('Message content missing or invalid:', message.content);
            messageContent += `${quoteChar} [No content]`;
        }
    
        messageContent += `\n<!-- UID: ${message.id || 'unknown'} -->\n`;
    
        if (authorName === "ChatGPT") {
            messageContent += "\n---\n";
        }
        return messageContent + '\n\n';
    }

    async writeToFile(fileName: string, content: string): Promise<void> {
        try {
            const file = this.app.vault.getAbstractFileByPath(fileName);
            if (file instanceof TFile) {
                await this.app.vault.modify(file, content);
                console.log(`[chatgpt-import] Updated existing file: ${fileName}`);
            } else {
                await this.app.vault.create(fileName, content);
                console.log(`[chatgpt-import] Created new file: ${fileName}`);
            }
        } catch (error) {
            this.logError(`Error creating or modifying file '${fileName}'`, error.message);
            throw error; // Propagate the error
        }
    }    

    async getAllExistingConversations() {
        const files = this.app.vault.getMarkdownFiles();
        const conversations = {};
    
        for (const file of files) {
            const fileContent = await this.app.vault.read(file);
            const match = fileContent.match(/^---\s*conversation_id:\s*(.*?)\s*---/ms);
            if (match) {
                const conversationId = match[1].trim();
                conversations[conversationId] = file.path;
            }
        }
        return conversations;
    }

    extractMessageUIDsFromNote(content: string): string[] {
        const uidRegex = /<!-- UID: (.*?) -->/g;
        const uids = [];
        let match;
        while ((match = uidRegex.exec(content)) !== null) {
            uids.push(match[1]);
        }
        return uids;
    }

    async writeImportLog(zipFileName: string): Promise<void> {
        const now = new Date();
        let prefix = formatTimestamp(now.getTime() / 1000, 'prefix');
    
        let logFileName = `${prefix} - ChatGPT Import log.md`;
        const logFolderPath = `${this.settings.archiveFolder}/logs`;
        
        const folderResult = await this.ensureFolderExists(logFolderPath);
        if (!folderResult.success) {
            this.logError(`Failed to create or access log folder: ${logFolderPath}`, folderResult.error);
            new Notice("Failed to create log file. Check console for details.");
            return;
        }
    
        let logFilePath = `${logFolderPath}/${logFileName}`;
    
        let counter = 1;
        while (await this.app.vault.adapter.exists(logFilePath)) {
            logFileName = `${prefix}-${counter} - ChatGPT Import log.md`;
            logFilePath = `${logFolderPath}/${logFileName}`;
            counter++;
        }
    
        const currentDate = `${formatTimestamp(now.getTime() / 1000, 'date')} ${formatTimestamp(now.getTime() / 1000, 'time')}`;
    
        const logContent = `---
importdate: ${currentDate}
zipFile: ${zipFileName}
totalSuccessfulImports: ${this.importLog.created.length}
totalUpdatedImports: ${this.importLog.updated.length}
totalSkippedImports: ${this.importLog.skipped.length}
---

# ChatGPT Import Log

Imported ZIP file: ${zipFileName}

${this.importLog.generateLogContent()}
`;
    
        try {
            await this.writeToFile(logFilePath, logContent);
            console.log(`Import log created: ${logFilePath}`);
        } catch (error) {
            this.logError(`Failed to write import log`, error.message);
            new Notice("Failed to create log file. Check console for details.");
        }
    }
    
    async resetCatalogs() {
        this.importedArchives = {};
        this.conversationRecords = {};
        await this.saveSettings();
        new Notice("All catalogs have been reset.");
        console.log("[chatgpt-import] All catalogs have been reset.");
    }    

    // Logging Methods
    private logError(message: string, details: string): void {
        this.logger.error(message, details);
        this.importLog.addError(message, details);
    }
    private logInfo(message: string, details?: any): void {
        this.logger.info(message, details);
    }
    private logWarn(message: string, details?: any): void {
        this.logger.warn(message, details);
    }

    // UI-related methods
    selectZipFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip';
        input.onchange = (e) => {
            const file = e.target.files?.[0];
            if (file) {
                this.handleZipFile(file);
            }
        };
        // Reset the input value to allow selecting the same file again
        input.value = '';
        input.click();
    }
    async validateZipFile(file: File): Promise<JSZip> {
        try {
            const zip = new JSZip();
            const content = await zip.loadAsync(file);
            const fileNames = Object.keys(content.files);
    
            if (!fileNames.includes('conversations.json')) {
                throw new ChatGPTImportError("Invalid ZIP structure", "File 'conversations.json' not found in the zip");
            }
    
            return zip;
        } catch (error) {
            if (error instanceof ChatGPTImportError) {
                throw error;
            } else {
                throw new ChatGPTImportError("Error validating zip file", error.message);
            }
        }
    }
    showConfirmationDialog(message: string): Promise<boolean> {
        return new Promise((resolve) => {
            const modal = new Modal(this.app);
            modal.contentEl.createEl("p", { text: message });
            
            const buttonContainer = modal.contentEl.createDiv();
            
            buttonContainer.createEl("button", { text: "Yes" }).addEventListener("click", () => {
                modal.close();
                resolve(true);
            });
            
            buttonContainer.createEl("button", { text: "No" }).addEventListener("click", () => {
                modal.close();
                resolve(false);
            });
            
            modal.open();
        });
    }
}

class ChatGPTImportPluginSettingTab extends PluginSettingTab {
    // Settings tab implementation

    plugin: ChatGPTImportPlugin;

    constructor(app: App, plugin: ChatGPTImportPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName('ChatGPT Archive Folder')
            .setDesc('Choose a folder to store ChatGPT archives')
            .addText(text => text
                .setPlaceholder('Enter folder name')
                .setValue(this.plugin.settings.archiveFolder)
                .onChange(async (value) => {
                    this.plugin.settings.archiveFolder = value;
                    await this.plugin.saveSettings();
                }));

        new Setting(containerEl)
            .setName('Add Date Prefix to Filenames')
            .setDesc('Add creation date as a prefix to conversation filenames')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.addDatePrefix)
                .onChange(async (value) => {
                    this.plugin.settings.addDatePrefix = value;
                    await this.plugin.saveSettings();
                    // Refresh the display to show/hide the date format option
                    this.display();
                }));

        if (this.plugin.settings.addDatePrefix) {
            new Setting(containerEl)
                .setName('Date Format')
                .setDesc('Choose the format for the date prefix')
                .addDropdown(dropdown => dropdown
                    .addOption('YYYY-MM-DD', 'YYYY-MM-DD')
                    .addOption('YYYYMMDD', 'YYYYMMDD')
                    .setValue(this.plugin.settings.dateFormat)
                    .onChange(async (value: 'YYYY-MM-DD' | 'YYYYMMDD') => {
                        this.plugin.settings.dateFormat = value;
                        await this.plugin.saveSettings();
                    }));
        }
    }
}

class ImportLog {
    // Properties and methods    
    private created: LogEntry[] = [];
    private updated: LogEntry[] = [];
    private skipped: LogEntry[] = [];
    private errors: LogEntry[] = [];
    private failed: LogEntry[] = [];
    private globalErrors: {message: string, details: string}[] = [];    

    addCreated(title: string, filePath: string, createDate: string, updateDate: string) {
        this.created.push({ title, filePath, createDate, updateDate });
    }

    addUpdated(title: string, filePath: string, createDate: string, updateDate: string) {
        this.updated.push({ title, filePath, createDate, updateDate });
    }

    addSkipped(title: string, filePath: string, createDate: string, updateDate: string, reason: string) {
        this.skipped.push({ title, filePath, createDate, updateDate, reason });
    }

    addFailed(title: string, filePath: string, createDate: string, updateDate: string, errorMessage: string) {
        this.failed.push({ title, filePath, createDate, updateDate, errorMessage });
    }
    
    addError(message: string, details: string) {
        this.globalErrors.push({ message, details });
    }

    addSummary(totalExisting: number, totalNew: number, totalUpdated: number, totalMessagesAdded: number) {
        this.summary = `
Summary:
- Existing conversations: ${totalExisting}
- New conversations imported: ${totalNew}
- Conversations updated: ${totalUpdated}
- New messages added: ${totalMessagesAdded}
`;
    }
    
    generateLogContent(): string {
        let content = '# ChatGPT Import Log\n\n';
        
        if (this.summary) {
            content += this.summary + '\n\n';
        }

        content += '## Legend\n';
        content += '✨ Created | 🔄 Updated | ⏭️ Skipped | 🚫 Failed | ⚠️ Global Errors\n\n';
        
        content += '## Table of Contents\n';
        if (this.created.length > 0) content += '- [Created Notes](#created-notes)\n';
        if (this.updated.length > 0) content += '- [Updated Notes](#updated-notes)\n';
        if (this.skipped.length > 0) content += '- [Skipped Notes](#skipped-notes)\n';
        if (this.failed.length > 0) content += '- [Failed Imports](#failed-imports)\n';
        if (this.globalErrors.length > 0) content += '- [Global Errors](#global-errors)\n';
        content += '\n';
    
        if (this.created.length > 0) {
            content += this.generateTable('Created Notes', this.created, '✨');
        }
        if (this.updated.length > 0) {
            content += this.generateTable('Updated Notes', this.updated, '🔄');
        }
        if (this.skipped.length > 0) {
            content += this.generateTable('Skipped Notes', this.skipped, '⏭️');
        }
        if (this.failed.length > 0) {
            content += this.generateTable('Failed Imports', this.failed, '🚫');
        }
        if (this.globalErrors.length > 0) {
            content += this.generateErrorTable('Global Errors', this.globalErrors, '⚠️');
        }
    
        return content;
    }
    
    private generateTable(title: string, entries: LogEntry[], emoji: string): string {
        let table = `## ${title}\n\n`;
        table += '| | Title | Created | Updated |\n';
        table += '|---|:---|:---:|:---:|\n';
        entries.forEach(entry => {
            const sanitizedTitle = entry.title.replace(/\n/g, ' ').trim();
            table += `| ${emoji} | [[${entry.filePath}\\|${sanitizedTitle}]] | ${entry.createDate} | ${entry.updateDate} |\n`;
        });
        return table + '\n\n';
    }

    private generateErrorTable(title: string, entries: {message: string, details: string}[], emoji: string): string {
        let table = `## ${title}\n\n`;
        table += '| | Error | Details |\n';
        table += '|---|:---|:---|\n';
        entries.forEach(entry => {
            table += `| ${emoji} | ${entry.message} | ${entry.details} |\n`;
        });
        return table + '\n\n';
    }

    hasErrors(): boolean {
        return this.errors.length > 0 || this.failed.length > 0;
    }
}

class ChatGPTImportError extends Error {
    // Implementation
    constructor(message: string, public details?: any) {
        super(message);
        this.name = 'ChatGPTImportError';
    }
}
