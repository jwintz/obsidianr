import { ItemView, WorkspaceLeaf, setIcon } from 'obsidian';
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
    allTime: {
        totalMs: number;
        books: Array<{
            path: string;
            title: string;
            coverSrc: string | null;
            totalMs: number;
            sessionCount: number;
            averageSessionMs: number;
            lastRead: number | null;
            firstRead: number | null;
            share: number;
            status: 'not-started' | 'in-progress' | 'completed';
            chaptersVisited: number;
            totalChapters: number;
            completionPercent: number;
            chaptersRemaining: number;
            timeToCompleteMs: number | null;
        }>;
    };
    streaks: {
        daily: { current: number; best: number; };
        weekly: { current: number; best: number; };
    };
    trend: {
        points: Array<{ timestamp: number; duration: number; hasData: boolean; }>;
        rollingAverageMs: number;
        lifetimeAverageMs: number;
    };
    peakHours: {
        buckets: Array<{ hour: number; totalMs: number; share: number; }>;
        top: { hour: number; totalMs: number; share: number; } | null;
    };
}

type TrendColumnPoint = {
    timestamp: number;
    duration: number;
    placeholder: boolean;
};

export class ReaderStatisticsView extends ItemView {
    private snapshot: StatisticsDisplaySnapshot | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private analysisMode: 'wide' | 'compact' | 'tight' = 'wide';
    private renderQueued = false;
    private contentWidth = 0;
    private trendObserver: ResizeObserver | null = null;
    private trendChartEl: HTMLElement | null = null;
    private trendChartWidth = 0;

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
        this.setupResizeObserver();
        this.render();
    }

    async onClose(): Promise<void> {
        this.panels.unregisterStatisticsView(this);
        this.containerEl.removeClass('obsidianr-stats-view');
        this.contentEl.removeClass('obsidianr-stats-root');
        this.teardownResizeObserver();
        this.detachTrendObserver();
    }

    setStatistics(snapshot: StatisticsDisplaySnapshot): void {
        this.snapshot = snapshot;
        this.render();
    }

    private render(): void {
        const root = this.contentEl;
        this.detachTrendObserver();
        root.empty?.();
        void this.applyAnalysisMode(root.clientWidth);
        if (!this.snapshot) {
            root.createEl('div', { text: 'Statistics will appear once you start reading.', cls: 'obsidianr-stats-empty' });
            return;
        }

        this.renderSessionSection(root);
        this.renderDailyCard(root);
        this.renderAggregates(root);
        this.renderStreakCard(root);
        this.renderTrendSection(root);
        this.renderPeakHoursSection(root);
        this.renderAllTimeSection(root);
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

    private renderDailyCard(root: HTMLElement): void {
        const container = root.createDiv({ cls: 'obsidianr-stats-grid obsidianr-stats-grid--single' });
        const card = container.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--gauge obsidianr-stats-card--daily' });
        card.createEl('h5', { text: 'Daily goal' });
        const daily = this.snapshot?.daily;
        if (!daily) {
            card.createEl('p', { text: 'No data yet.', cls: 'obsidianr-gauge-summary' });
            return;
        }
        const block = card.createDiv({ cls: 'obsidianr-gauge-block' });
        block.createEl('span', { text: 'Today', cls: 'obsidianr-gauge-label' });
        const percent = this.createSemiGauge(block, daily.totalMs, daily.goalMs);
        const summary = card.createDiv({ cls: 'obsidianr-gauge-summary' });
        if (daily.goalMs > 0) {
            summary.textContent = `${this.formatDuration(daily.totalMs)} / ${this.formatDuration(daily.goalMs)} (${Math.min(999, percent)}%)`;
        } else {
            summary.textContent = `${this.formatDuration(daily.totalMs)} read — set a daily goal in settings.`;
        }
    }

    private renderStreakCard(root: HTMLElement): void {
        const streaks = this.snapshot?.streaks;
        const card = root.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--streaks' });
        card.createEl('h5', { text: 'Streaks' });
        if (!streaks) {
            card.createEl('p', { text: 'No streaks yet — keep reading!', cls: 'obsidianr-stats-empty' });
            return;
        }
        const list = card.createDiv({ cls: 'obsidianr-stats-streaks' });
        this.renderStreakItem(list, 'Daily', streaks.daily.current, streaks.daily.best);
        this.renderStreakItem(list, 'Weekly', streaks.weekly.current, streaks.weekly.best);
    }

    private renderStreakItem(container: HTMLElement, label: string, current: number, best: number): void {
        const item = container.createDiv({ cls: 'obsidianr-stats-streak' });
        const title = item.createDiv({ cls: 'obsidianr-stats-streak-label' });
        title.textContent = label;
        const values = item.createDiv({ cls: 'obsidianr-stats-streak-values' });
        values.createSpan({ text: `${current}`, cls: 'obsidianr-stats-streak-current' });
        values.createSpan({ text: `Best ${best}`, cls: 'obsidianr-stats-streak-best' });
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

    }

    private renderTrendSection(root: HTMLElement): void {
        const trend = this.snapshot?.trend;
        const card = root.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--trend' });
        card.createEl('h5', { text: 'Session trend' });
        if (!trend) {
            card.createEl('p', { text: 'Trend data appears after a few reading sessions.', cls: 'obsidianr-stats-empty' });
            return;
        }

        const summary = card.createDiv({ cls: 'obsidianr-stats-trend-summary' });
        summary.createSpan({ text: `Rolling avg: ${this.formatDuration(trend.rollingAverageMs)}` });
        summary.createSpan({ text: `All-time avg: ${this.formatDuration(trend.lifetimeAverageMs)}` });
        const chart = card.createDiv({ cls: 'obsidianr-stats-trend-chart' });
        const columnCount = this.computeTrendColumnCount(chart, trend.points.length);
        const decoratedPoints = this.ensureTrendPoints(trend, columnCount);
        this.observeTrendChart(chart);
        if (decoratedPoints.length === 0) {
            card.createEl('p', { text: 'Trend data appears after a few reading sessions.', cls: 'obsidianr-stats-empty' });
            return;
        }
        const chartHeight = chart.getBoundingClientRect().height || 140;
        const paddingAllowance = 8;
        const effectiveRange = Math.max(0, chartHeight - paddingAllowance);
        const maxDuration = Math.max(
            trend.rollingAverageMs,
            trend.lifetimeAverageMs,
            ...decoratedPoints.map((entry) => entry.duration),
            1
        );

        for (const point of decoratedPoints) {
            const column = chart.createDiv({ cls: 'obsidianr-stats-trend-column' });
            const fill = column.createDiv({ cls: `obsidianr-stats-trend-column-fill${point.placeholder ? ' is-placeholder' : ''}` });
            const ratio = maxDuration > 0 ? point.duration / maxDuration : 0;
            const heightRatio = ratio > 0 ? Math.max(0.05, Math.min(ratio, 1)) : (point.placeholder ? 0.12 : 0);
            const baseMin = point.placeholder ? 8 : 4;
            const scaled = Math.round(heightRatio * effectiveRange);
            const maxFillHeight = Math.max(baseMin, effectiveRange);
            const heightPx = Math.min(maxFillHeight, Math.max(baseMin, scaled));
            fill.style.height = `${heightPx}px`;
            const tooltipSegments = [`${this.formatDuration(point.duration)}`];
            if (point.placeholder) {
                tooltipSegments.push('(estimated)');
            }
            tooltipSegments.push(this.formatDate(point.timestamp));
            fill.setAttr('title', tooltipSegments.join(' • '));
            column.createSpan({ text: this.shortDate(point.timestamp), cls: 'obsidianr-stats-trend-column-label' });
        }
    }

    private renderPeakHoursSection(root: HTMLElement): void {
        const peakHours = this.snapshot?.peakHours;
        const card = root.createDiv({ cls: 'obsidianr-stats-card obsidianr-stats-card--peak' });
        card.createEl('h5', { text: 'Peak reading hours' });
        if (!peakHours || !peakHours.buckets.length || !peakHours.top || peakHours.top.totalMs <= 0) {
            card.createEl('p', { text: 'No hourly reading data yet.', cls: 'obsidianr-stats-empty' });
            return;
        }

        const summary = card.createDiv({ cls: 'obsidianr-peak-summary' });
        summary.createSpan({ text: `${this.formatHour(peakHours.top.hour)} • ${this.formatPercent(peakHours.top.share)}` });
        summary.createSpan({ text: `${this.formatDuration(peakHours.top.totalMs)} read`, cls: 'obsidianr-peak-summary-duration' });
        const grid = card.createDiv({ cls: 'obsidianr-peak-grid' });
        const maxShare = peakHours.buckets.reduce((max, bucket) => Math.max(max, bucket.share), 0);
        for (const bucket of peakHours.buckets) {
            const ratio = maxShare > 0 ? Math.max(0.05, bucket.share / maxShare) : 0;
            const chip = grid.createDiv({ cls: `obsidianr-peak-chip${bucket.hour === peakHours.top.hour ? ' is-top' : ''}` });
            chip.style.setProperty('--obsidianr-peak-intensity', ratio.toFixed(3));
            chip.setAttr('title', `${this.formatHour(bucket.hour)} • ${this.formatPercent(bucket.share)} • ${this.formatDuration(bucket.totalMs)}`);

            const header = chip.createDiv({ cls: 'obsidianr-peak-chip-hour' });
            header.createSpan({ text: this.formatHour(bucket.hour), cls: 'obsidianr-peak-chip-hour-label' });
            const headerMeta = header.createDiv({ cls: 'obsidianr-peak-chip-hour-meta' });
            const isTop = bucket.hour === peakHours.top.hour;
            if (!isTop) {
                const iconName = this.clockIconForHour(bucket.hour);
                if (iconName) {
                    const icon = headerMeta.createSpan({ cls: 'obsidianr-peak-chip-icon' });
                    setIcon(icon, iconName);
                    icon.setAttr('aria-hidden', 'true');
                }
            }
            if (isTop) {
                headerMeta.createSpan({ text: 'Top', cls: 'obsidianr-peak-chip-badge' });
            }

            chip.createDiv({
                text: `${this.formatPercent(bucket.share)} · ${this.formatDuration(bucket.totalMs)}`,
                cls: 'obsidianr-peak-chip-meta'
            });

            const bar = chip.createDiv({ cls: 'obsidianr-peak-chip-bar' });
            bar.style.setProperty('--obsidianr-peak-fill', `${Math.round(ratio * 100)}%`);
        }
    }

    private renderAllTimeSection(root: HTMLElement): void {
        const allTime = this.snapshot?.allTime;
        if (!allTime) {
            return;
        }
        const details = root.createEl('details', { cls: 'obsidianr-stats-card obsidianr-stats-alltime' });
        details.dataset.collapsible = 'true';
        if (allTime.books.length > 0) {
            details.setAttr('open', '');
        }
        const summary = details.createEl('summary', { cls: 'obsidianr-stats-alltime-summary' });
        summary.createSpan({ text: 'Analytics', cls: 'obsidianr-stats-alltime-summary-title' });
        summary.createSpan({ text: allTime.totalMs > 0 ? this.formatDuration(allTime.totalMs) : '—', cls: 'obsidianr-stats-alltime-summary-total' });

        const body = details.createDiv({ cls: 'obsidianr-stats-alltime-body' });
        if (allTime.books.length === 0) {
            body.createEl('p', { text: 'Start reading to build your long-term statistics.', cls: 'obsidianr-stats-empty' });
            return;
        }

        const labels = ['Total time', 'Sessions', 'Avg session', 'Status', 'Progress', 'Time to complete', 'Last read', 'Library share'];

        const header = body.createDiv({ cls: 'obsidianr-stats-alltime-header' });
        header.createSpan({ text: 'Book', cls: 'obsidianr-stats-alltime-header-book' });
        const headerMetrics = header.createDiv({ cls: 'obsidianr-stats-alltime-metrics is-header' });
        for (const label of labels) {
            const cell = headerMetrics.createDiv({ cls: 'obsidianr-stats-alltime-metric is-header' });
            cell.createSpan({ text: label, cls: 'obsidianr-stats-alltime-metric-label' });
        }

        for (const book of allTime.books) {
            const row = body.createDiv({ cls: 'obsidianr-stats-alltime-row' });
            const bookCell = row.createDiv({ cls: 'obsidianr-stats-alltime-book' });
            if (book.coverSrc) {
                const cover = bookCell.createEl('img', { cls: 'obsidianr-stats-alltime-cover', attr: { alt: book.title } });
                cover.src = book.coverSrc;
            } else {
                const placeholder = bookCell.createDiv({ cls: 'obsidianr-stats-alltime-cover is-placeholder' });
                placeholder.createSpan({ text: book.title.slice(0, 1).toUpperCase(), cls: 'obsidianr-stats-alltime-cover-initial' });
            }
            const info = bookCell.createDiv({ cls: 'obsidianr-stats-alltime-info' });
            info.createEl('span', { text: book.title, cls: 'obsidianr-stats-alltime-title' });
            info.createEl('span', { text: this.basenameFromPath(book.path), cls: 'obsidianr-stats-alltime-path' });
            const statusBadge = info.createSpan({ text: this.formatStatus(book.status), cls: `obsidianr-stats-status is-${book.status}` });
            statusBadge.setAttr('aria-label', `Status ${this.formatStatus(book.status)}`);

            const progressValue = book.totalChapters > 0
                ? `${book.chaptersVisited}/${book.totalChapters} (${this.formatPercent(book.completionPercent)})`
                : (book.chaptersVisited > 0 ? `${book.chaptersVisited} visited` : '—');
            const completion = book.timeToCompleteMs != null ? this.formatDuration(book.timeToCompleteMs) : '—';

            const metricsData = [
                { label: 'Total time', value: this.formatDuration(book.totalMs) },
                { label: 'Sessions', value: `${book.sessionCount}` },
                { label: 'Avg session', value: this.formatDuration(book.averageSessionMs) },
                { label: 'Status', value: this.formatStatus(book.status), className: `is-status-${book.status}` },
                { label: 'Progress', value: progressValue },
                { label: 'Time to complete', value: completion },
                { label: 'Last read', value: this.formatDate(book.lastRead) },
                { label: 'Library share', value: this.formatPercent(book.share) }
            ];

            const metrics = row.createDiv({ cls: 'obsidianr-stats-alltime-metrics' });
            for (const metric of metricsData) {
                const item = this.createMetricItem(metrics, metric.label, metric.value);
                if (metric.className) {
                    item.classList.add(metric.className);
                }
            }

            const compact = row.createDiv({ cls: 'obsidianr-analysis-compact' });
            for (const metric of metricsData) {
                this.createCompactMetric(compact, metric.label, metric.value, metric.className);
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

    private ensureTrendPoints(trend: StatisticsDisplaySnapshot['trend'], desiredCount: number): TrendColumnPoint[] {
        if (trend.points.length === 0 || desiredCount <= 0) {
            return [];
        }
        const count = Math.max(1, Math.min(desiredCount, trend.points.length));
        const base = this.estimatePlaceholderDuration(trend);
        return trend.points.slice(-count).map((point) => ({
            timestamp: point.timestamp,
            duration: point.hasData ? point.duration : base,
            placeholder: !point.hasData
        }));
    }

    private estimatePlaceholderDuration(trend: StatisticsDisplaySnapshot['trend']): number {
        if (trend.rollingAverageMs > 0) {
            return trend.rollingAverageMs;
        }
        if (trend.lifetimeAverageMs > 0) {
            return trend.lifetimeAverageMs;
        }
        return 45 * 60 * 1000;
    }

    private computeTrendColumnCount(chart: HTMLElement, totalPoints: number): number {
        const cappedPoints = Math.max(0, Math.min(totalPoints, 14));
        if (cappedPoints === 0) {
            return 0;
        }
        const rect = chart.getBoundingClientRect();
        const width = rect.width;
        if (width <= 0) {
            if (!this.renderQueued) {
                this.scheduleRender();
            }
            return this.fallbackTrendColumnCount(cappedPoints);
        }
        const minColumnWidth = 22; // approximate column width in px
        const columnGap = 8;
        const capacity = Math.floor((width + columnGap) / (minColumnWidth + columnGap));
        const minRequired = Math.min(cappedPoints, totalPoints >= 3 ? 3 : totalPoints);
        const desired = Math.max(1, capacity);
        return Math.max(minRequired > 0 ? minRequired : 1, Math.min(cappedPoints, desired));
    }

    private fallbackTrendColumnCount(totalPoints: number): number {
        const target = this.analysisMode === 'tight'
            ? 3
            : this.analysisMode === 'compact'
                ? 7
                : 14;
        return Math.max(1, Math.min(totalPoints, target));
    }

    private observeTrendChart(chart: HTMLElement): void {
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        if (this.trendObserver) {
            this.trendObserver.disconnect();
            this.trendObserver = null;
        }
        this.trendChartEl = chart;
        this.trendChartWidth = chart.getBoundingClientRect().width;
        this.trendObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target === this.trendChartEl) {
                    const width = entry.contentRect.width;
                    if (Math.abs(width - this.trendChartWidth) > 1) {
                        this.trendChartWidth = width;
                        this.scheduleRender();
                    }
                }
            }
        });
        this.trendObserver.observe(chart);
    }

    private detachTrendObserver(): void {
        if (this.trendObserver) {
            this.trendObserver.disconnect();
            this.trendObserver = null;
        }
        this.trendChartEl = null;
        this.trendChartWidth = 0;
    }

    private scheduleRender(): void {
        if (this.renderQueued || !this.containerEl.isConnected || typeof window === 'undefined') {
            return;
        }
        this.renderQueued = true;
        window.requestAnimationFrame(() => {
            this.renderQueued = false;
            if (!this.containerEl.isConnected) {
                return;
            }
            this.render();
        });
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

    private clockIconForHour(hour: number): string | null {
        if (!Number.isFinite(hour)) {
            return null;
        }
        const normalized = ((Math.round(hour) % 24) + 24) % 24;
        const hour12 = normalized % 12 === 0 ? 12 : normalized % 12;
        return `clock-${hour12}`;
    }

    private formatDate(timestamp: number | null): string {
        if (!timestamp) {
            return '—';
        }
        const date = new Date(timestamp);
        return date.toLocaleDateString(undefined, {
            year: 'numeric',
            month: 'short',
            day: 'numeric'
        });
    }

    private formatPercent(value: number): string {
        if (!isFinite(value) || value <= 0) {
            return '0%';
        }
        const percent = Math.round(value * 1000) / 10;
        return `${percent}%`;
    }

    private formatStatus(status: 'not-started' | 'in-progress' | 'completed'): string {
        switch (status) {
            case 'completed':
                return 'Completed';
            case 'in-progress':
                return 'In progress';
            case 'not-started':
            default:
                return 'Not started';
        }
    }

    private shortDate(timestamp: number): string {
        const date = new Date(timestamp);
        return date.toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric'
        });
    }

    private formatHour(hour: number): string {
        if (!Number.isFinite(hour)) {
            return '—';
        }
        const normalized = Math.round(hour) % 24;
        return `${normalized.toString().padStart(2, '0')}:00`;
    }

    private createMetricItem(container: HTMLElement, label: string, value: string): HTMLElement {
        const item = container.createDiv({ cls: 'obsidianr-stats-alltime-metric' });
        item.createSpan({ text: label, cls: 'obsidianr-stats-alltime-metric-label' });
        item.createSpan({ text: value, cls: 'obsidianr-stats-alltime-metric-value' });
        return item;
    }

    private createCompactMetric(container: HTMLElement, label: string, value: string, className?: string): void {
        const item = container.createDiv({ cls: 'obsidianr-analysis-compact-item' });
        item.createSpan({ text: label, cls: 'obsidianr-analysis-compact-label' });
        const valueEl = item.createSpan({ text: value, cls: 'obsidianr-analysis-compact-value' });
        if (className) {
            valueEl.classList.add(className);
        }
    }

    private basenameFromPath(path: string): string {
        const parts = path.split('/');
        return parts[parts.length - 1] ?? path;
    }

    private setupResizeObserver(): void {
        if (typeof ResizeObserver === 'undefined') {
            return;
        }
        this.teardownResizeObserver();
        this.resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
                if (entry.target !== this.contentEl) {
                    continue;
                }
                const width = entry.contentRect.width;
                const modeChanged = this.applyAnalysisMode(width);
                if (modeChanged || Math.abs(width - this.contentWidth) > 1) {
                    this.contentWidth = width;
                    this.scheduleRender();
                }
            }
        });
        this.resizeObserver.observe(this.contentEl);
        this.contentWidth = this.contentEl.clientWidth;
        void this.applyAnalysisMode(this.contentWidth);
    }

    private teardownResizeObserver(): void {
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = null;
        }
    }

    private applyAnalysisMode(width: number): boolean {
        const root = this.contentEl;
        if (!root) {
            return false;
        }
        let nextMode: 'wide' | 'compact' | 'tight' = 'wide';
        if (width < 720) {
            nextMode = 'tight';
        } else if (width < 1100) {
            nextMode = 'compact';
        }
        if (nextMode === this.analysisMode) {
            return false;
        }
        this.analysisMode = nextMode;
        root.toggleClass('is-analysis-compact', nextMode !== 'wide');
        root.toggleClass('is-analysis-tight', nextMode === 'tight');
        return true;
    }
}
