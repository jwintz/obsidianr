import { ItemView, WorkspaceLeaf } from 'obsidian';
import type ObsidianRPlugin from '../../main';
import type { ReaderPanelManager } from './manager';

export const STATISTICS_VIEW_TYPE = 'obsidianr-reader-statistics';

export interface StatisticsDisplaySnapshot {
    session: {
        active: boolean;
        durationMs: number;
        start: number | null;
        lastInteraction: number | null;
        bookTitle: string | null;
        chapterTitle: string | null;
        coverSrc: string | null;
    };
    daily: {
        totalMs: number;
        goalMs: number;
    };
    weekly: {
        totalMs: number;
        goalMs: number;
    };
    monthly: {
        totalMs: number;
        goalMs: number;
    };
    yearly: {
        totalMs: number;
        goalMs: number;
        books: Array<{ title: string; totalMs: number; }>;
    };
}

export class ReaderStatisticsView extends ItemView {
    private snapshot: StatisticsDisplaySnapshot | null = null;

    constructor(
        leaf: WorkspaceLeaf,
        private readonly plugin: ObsidianRPlugin,
        private readonly panels: ReaderPanelManager
    ) {
        super(leaf);
    }

    getViewType(): string {
        return STATISTICS_VIEW_TYPE;
    }

    getDisplayText(): string {
        return 'Reading statistics';
    }

    getIcon(): string {
        return 'pie-chart';
    }

    async onOpen(): Promise<void> {
        this.containerEl.addClass('obsidianr-stats-view');
        this.contentEl.addClass('obsidianr-stats-root');
        this.panels.registerStatisticsView(this);
        this.render();
    }

    async onClose(): Promise<void> {
        this.panels.unregisterStatisticsView(this);
        this.containerEl.removeClass('obsidianr-stats-view');
        this.contentEl.removeClass('obsidianr-stats-root');
    }

    setStatistics(snapshot: StatisticsDisplaySnapshot): void {
        this.snapshot = snapshot;
        this.render();
    }

    private render(): void {
        const root = this.contentEl;
        root.empty?.();
        if (!this.snapshot) {
            root.createEl('div', { text: 'Statistics will appear once you start reading.', cls: 'obsidianr-stats-empty' });
            return;
        }

        this.renderSessionSection(root);
        this.renderDailySection(root);
        this.renderAggregates(root);
    }

    private renderSessionSection(root: HTMLElement): void {
        const section = root.createDiv({ cls: 'obsidianr-stats-section' });
        const session = this.snapshot?.session;
        if (!session?.active) {
            section.createEl('h4', { text: 'Current session' });
            section.createEl('p', { text: 'No active reading session.' });
            return;
        }
        const card = section.createDiv({ cls: 'obsidianr-stats-session-card' });
        const details = card.createDiv({ cls: 'obsidianr-stats-session-details' });
        details.createEl('h4', { text: 'Current session', cls: 'obsidianr-stats-session-heading' });
        details.createEl('div', { text: `Time reading: ${this.formatDuration(session.durationMs)}`, cls: 'obsidianr-stats-session-line' });
        if (session.bookTitle) {
            details.createEl('div', { text: `Book: ${session.bookTitle}`, cls: 'obsidianr-stats-session-line' });
        }
        if (session.chapterTitle) {
            details.createEl('div', { text: `Chapter: ${session.chapterTitle}`, cls: 'obsidianr-stats-session-line' });
        }
        if (session.coverSrc) {
            const coverWrap = card.createDiv({ cls: 'obsidianr-stats-session-cover-wrap' });
            const cover = coverWrap.createEl('img', { cls: 'obsidianr-stats-session-cover', attr: { alt: session.bookTitle ?? 'Book cover' } });
            cover.src = session.coverSrc;
        }
    }

    private renderDailySection(root: HTMLElement): void {
        const section = root.createDiv({ cls: 'obsidianr-stats-section' });
        section.createEl('h4', { text: 'Daily goal' });
        const daily = this.snapshot?.daily;
        if (!daily) {
            section.createEl('p', { text: 'No data yet.' });
            return;
        }
        const block = section.createDiv({ cls: 'obsidianr-gauge-block' });
        block.createEl('span', { text: 'Today', cls: 'obsidianr-gauge-label' });
        const percent = this.createSemiGauge(block, daily.totalMs, daily.goalMs);
        const summary = block.createDiv({ cls: 'obsidianr-gauge-summary' });
        if (daily.goalMs > 0) {
            summary.textContent = `${this.formatDuration(daily.totalMs)} / ${this.formatDuration(daily.goalMs)} (${Math.min(999, percent)}%)`;
        } else {
            summary.textContent = `${this.formatDuration(daily.totalMs)} read — set a daily goal in settings.`;
        }
    }

    private renderAggregates(root: HTMLElement): void {
        const { weekly, monthly, yearly } = this.snapshot!;
        const aggregateSection = root.createDiv({ cls: 'obsidianr-stats-grid' });

        const weeklyCard = aggregateSection.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--gauge' });
        weeklyCard.createEl('h5', { text: 'Week' });
        const weeklyPercent = this.createGaugeBlock(weeklyCard, 'This week', weekly.totalMs, weekly.goalMs);
        weeklyCard.createEl('p', { text: weekly.goalMs > 0 ? `${this.formatDuration(weekly.totalMs)} / ${this.formatDuration(weekly.goalMs)} (${Math.min(999, weeklyPercent)}%)` : `${this.formatDuration(weekly.totalMs)} read`, cls: 'obsidianr-gauge-summary' });

        const monthlyCard = aggregateSection.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--gauge' });
        monthlyCard.createEl('h5', { text: 'Month' });
        const monthlyPercent = this.createGaugeBlock(monthlyCard, 'This month', monthly.totalMs, monthly.goalMs);
        monthlyCard.createEl('p', { text: monthly.goalMs > 0 ? `${this.formatDuration(monthly.totalMs)} / ${this.formatDuration(monthly.goalMs)} (${Math.min(999, monthlyPercent)}%)` : `${this.formatDuration(monthly.totalMs)} read`, cls: 'obsidianr-gauge-summary' });

        const yearlyCard = aggregateSection.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--gauge' });
        yearlyCard.createEl('h5', { text: 'Year' });
        const yearlyPercent = this.createGaugeBlock(yearlyCard, 'This year', yearly.totalMs, yearly.goalMs);
        yearlyCard.createEl('p', { text: yearly.goalMs > 0 ? `${this.formatDuration(yearly.totalMs)} / ${this.formatDuration(yearly.goalMs)} (${Math.min(999, yearlyPercent)}%)` : `${this.formatDuration(yearly.totalMs)} read`, cls: 'obsidianr-gauge-summary' });

        if (yearly.books.length > 0) {
            const list = yearlyCard.createEl('ul', { cls: 'obsidianr-stats-book-list' });
            for (const book of yearly.books) {
                const item = list.createEl('li');
                item.createEl('span', { text: book.title, cls: 'obsidianr-stats-book-title' });
                item.createEl('span', { text: this.formatDuration(book.totalMs), cls: 'obsidianr-stats-book-duration' });
            }
        }
    }

    private createGaugeBlock(container: HTMLElement, label: string, totalMs: number, goalMs: number): number {
        const block = container.createDiv({ cls: 'obsidianr-gauge-block' });
        block.createEl('span', { text: label, cls: 'obsidianr-gauge-label' });
        return this.createSemiGauge(block, totalMs, goalMs);
    }

    private createSemiGauge(container: HTMLElement, totalMs: number, goalMs: number): number {
        const gauge = container.createDiv({ cls: 'obsidianr-gauge' });
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        svg.setAttribute('viewBox', '0 0 120 70');
        svg.classList.add('obsidianr-gauge-svg');

        const pathData = 'M10 60 A 50 50 0 0 1 110 60';
        const background = document.createElementNS(svgNS, 'path');
        background.setAttribute('d', pathData);
        background.setAttribute('pathLength', '100');
        background.classList.add('obsidianr-gauge-arc');
        svg.appendChild(background);

        const progressPath = document.createElementNS(svgNS, 'path');
        progressPath.setAttribute('d', pathData);
        progressPath.setAttribute('pathLength', '100');
        progressPath.classList.add('obsidianr-gauge-arc', 'is-progress');

        const percent = goalMs > 0 ? Math.round((totalMs / goalMs) * 100) : 0;
        const progress = goalMs > 0 ? Math.min(totalMs / goalMs, 1) : 0;
        const dashOffset = (1 - Math.max(0, Math.min(progress, 1))) * 100;
        progressPath.setAttribute('stroke-dasharray', '100');
        progressPath.setAttribute('stroke-dashoffset', dashOffset.toString());
        svg.appendChild(progressPath);

        gauge.appendChild(svg);

        const center = gauge.createDiv({ cls: 'obsidianr-gauge-center' });
        center.createSpan({ text: goalMs > 0 ? `${Math.min(999, Math.max(percent, 0))}%` : '—', cls: 'obsidianr-gauge-center-text' });

        return goalMs > 0 ? Math.max(percent, 0) : 0;
    }

    private formatDuration(ms: number): string {
        if (ms <= 0) {
            return '0m';
        }
        const totalMinutes = Math.round(ms / 60000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        const parts: string[] = [];
        if (hours > 0) {
            parts.push(`${hours}h`);
        }
        if (minutes > 0 || parts.length === 0) {
            parts.push(`${minutes}m`);
        }
        return parts.join(' ');
    }
}
