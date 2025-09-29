import { Events, TFile } from 'obsidian';

export interface ReaderParameters {
    fontSize: number;
    lineSpacing: number;
    letterSpacing: number;
    wordSpacing: number;
    columns: number;
    horizontalMargins: number;
    justified: boolean;
    transitionType: 'none' | 'page-curl' | 'slide' | 'fade' | 'scroll';
}

export interface ReaderSessionState {
    active: boolean;
    currentFile: TFile | null;
    currentPage: number;
    totalPages: number;
    pageHeight: number;
    overlayVisible: boolean;
    zenMode: boolean;
    lastInteractionTs: number;
    parameters: ReaderParameters;
}

const SESSION_IDLE_TIMEOUT = 5 * 60 * 1000; // 5 minutes

export class ReaderState extends Events {
    private state: ReaderSessionState;

    constructor(initial: ReaderSessionState) {
        super();
        this.state = initial;
    }

    get snapshot(): ReaderSessionState {
        return { ...this.state, parameters: { ...this.state.parameters } };
    }

    update(partial: Partial<ReaderSessionState>): void {
        const prev = this.snapshot;
        this.state = {
            ...this.state,
            ...partial,
            parameters: {
                ...this.state.parameters,
                ...(partial.parameters ?? {})
            }
        };
        this.trigger('changed', this.snapshot, prev);
    }

    updateParameters(partial: Partial<ReaderParameters>): void {
        this.update({ parameters: { ...this.state.parameters, ...partial } });
    }

    markInteraction(timestamp = Date.now()): void {
        this.state.lastInteractionTs = timestamp;
        this.trigger('interaction', timestamp);
    }

    hasTimedOut(timestamp = Date.now()): boolean {
        return timestamp - this.state.lastInteractionTs > SESSION_IDLE_TIMEOUT;
    }
}

export function createInitialState(): ReaderSessionState {
    return {
        active: false,
        currentFile: null,
        currentPage: 0,
        totalPages: 0,
    pageHeight: 0,
        overlayVisible: false,
        zenMode: false,
        lastInteractionTs: Date.now(),
        parameters: {
            fontSize: 18,
            lineSpacing: 1.4,
            letterSpacing: 0,
            wordSpacing: 0,
            columns: 1,
            horizontalMargins: 12,
            justified: true,
            transitionType: 'none'
        }
    };
}
