import { Notice } from 'obsidian';
import type ObsidianRPlugin from '../main';
import { ReaderManager } from '../reader/manager';
import { ReaderState } from './state';

export class CommandCenter {
    constructor(
        private readonly plugin: ObsidianRPlugin,
        private readonly manager: ReaderManager,
        private readonly state: ReaderState
    ) { }

    register(): void {
        this.plugin.addCommand({
            id: 'obsidianr-toggle-reader-mode',
            name: 'Toggle reader mode',
            callback: () => this.manager.toggleReaderMode()
        });

        this.plugin.addCommand({
            id: 'obsidianr-next-page',
            name: 'Next page',
            checkCallback: (checking) => {
                if (!this.state.snapshot.active) {
                    return false;
                }
                if (!checking) {
                    this.manager.nextPage();
                }
                return true;
            }
        });

        this.plugin.addCommand({
            id: 'obsidianr-previous-page',
            name: 'Previous page',
            checkCallback: (checking) => {
                if (!this.state.snapshot.active) {
                    return false;
                }
                if (!checking) {
                    this.manager.previousPage();
                }
                return true;
            }
        });

        this.plugin.addCommand({
            id: 'obsidianr-increase-font-size',
            name: 'Increase font size',
            checkCallback: (checking) => {
                if (!this.state.snapshot.active) {
                    return false;
                }
                if (!checking) {
                    this.adjustFont(+1);
                }
                return true;
            }
        });

        this.plugin.addCommand({
            id: 'obsidianr-decrease-font-size',
            name: 'Decrease font size',
            checkCallback: (checking) => {
                if (!this.state.snapshot.active) {
                    return false;
                }
                if (!checking) {
                    this.adjustFont(-1);
                }
                return true;
            }
        });
    }

    nextPage(): void {
        if (!this.requireActive()) {
            return;
        }
        this.manager.nextPage();
    }

    previousPage(): void {
        if (!this.requireActive()) {
            return;
        }
        this.manager.previousPage();
    }

    increaseFont(): void {
        if (!this.requireActive()) {
            return;
        }
        this.adjustFont(+1);
    }

    decreaseFont(): void {
        if (!this.requireActive()) {
            return;
        }
        this.adjustFont(-1);
    }

    private adjustFont(delta: number): void {
        const snapshot = this.state.snapshot;
        const nextSize = Math.min(72, Math.max(8, snapshot.parameters.fontSize + delta));
        if (nextSize === snapshot.parameters.fontSize) {
            return;
        }
        this.manager.updateParameters({ fontSize: nextSize });
        this.notify(`Font size ${delta > 0 ? 'increased' : 'decreased'} to ${nextSize}px`);
    }

    private requireActive(): boolean {
        if (!this.state.snapshot.active) {
            new Notice('Reader mode is not active');
            return false;
        }
        return true;
    }

    private notify(message: string): void {
        new Notice(message, 1500);
    }
}

export function createCommandCenter(
    plugin: ObsidianRPlugin,
    manager: ReaderManager,
    state: ReaderState
): CommandCenter {
    return new CommandCenter(plugin, manager, state);
}
