import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type ObsidianRPlugin from '../main';

export interface ObsidianRSettings {
    justified: boolean;
    horizontalMargins: number;
    columns: number;
    lineSpacing: number;
    characterSpacing: number;
    wordSpacing: number;
    fontSize: number;
    transitionType: 'none' | 'page-curl' | 'slide' | 'fade' | 'scroll';
    dailyGoalMinutes: number;
}

export const DEFAULT_SETTINGS: ObsidianRSettings = {
    justified: true,
    horizontalMargins: 12,
    columns: 1,
    lineSpacing: 1.4,
    characterSpacing: 0,
    wordSpacing: 0,
    fontSize: 18,
    transitionType: 'slide',
    dailyGoalMinutes: 30
};

export class ObsidianRSettingTab extends PluginSettingTab {
    plugin: ObsidianRPlugin;

    constructor(app: App, plugin: ObsidianRPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h3', { text: 'Format' });

        new Setting(containerEl)
            .setName('Justified')
            .setDesc('Enable text justification by default in reader mode')
            .addToggle((toggle) =>
                toggle
                    .setValue(this.plugin.settings.justified)
                    .onChange(async (value) => {
                        this.plugin.settings.justified = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Horizontal Margins')
            .setDesc('Set the horizontal margins as a percentage of screen width')
            .addSlider((slider) =>
                slider
                    .setLimits(0, 30, 1)
                    .setValue(this.plugin.settings.horizontalMargins)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.horizontalMargins = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Columns')
            .setDesc('Number of text columns in reader mode')
            .addSlider((slider) =>
                slider
                    .setLimits(1, 3, 1)
                    .setValue(this.plugin.settings.columns)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.columns = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Line Spacing')
            .setDesc('Adjust line spacing (1.0 = normal, 1.5 = 1.5x spacing)')
            .addSlider((slider) =>
                slider
                    .setLimits(0.8, 2.5, 0.1)
                    .setValue(this.plugin.settings.lineSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.lineSpacing = Math.round(value * 10) / 10;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Character Spacing')
            .setDesc('Adjust spacing between characters (0 = normal)')
            .addSlider((slider) =>
                slider
                    .setLimits(-0.1, 0.5, 0.01)
                    .setValue(this.plugin.settings.characterSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.characterSpacing = Math.round(value * 100) / 100;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Word Spacing')
            .setDesc('Adjust spacing between words (0 = normal, small values recommended)')
            .addSlider((slider) =>
                slider
                    .setLimits(0.0, 0.5, 0.01)
                    .setValue(this.plugin.settings.wordSpacing)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.wordSpacing = Math.round(value * 100) / 100;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        new Setting(containerEl)
            .setName('Font Size')
            .setDesc('Default font size in pixels (can be adjusted in reader mode)')
            .addSlider((slider) =>
                slider
                    .setLimits(8, 48, 1)
                    .setValue(this.plugin.settings.fontSize)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.fontSize = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        containerEl.createEl('h3', { text: 'Transitions' });

        new Setting(containerEl)
            .setName('Transition Type')
            .setDesc('Choose the page transition animation for reader mode')
            .addDropdown((dropdown) =>
                dropdown
                    .addOption('none', 'None')
                    .addOption('page-curl', 'Page Curl')
                    .addOption('slide', 'Slide')
                    .addOption('fade', 'Fade')
                    .addOption('scroll', 'Scroll')
                    .setValue(this.plugin.settings.transitionType)
                    .onChange(async (value) => {
                        this.plugin.settings.transitionType = value as typeof this.plugin.settings.transitionType;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        containerEl.createEl('h3', { text: 'Goals' });

        new Setting(containerEl)
            .setName('Daily reading goal (minutes)')
            .setDesc('Used for daily statistics and streaks')
            .addSlider((slider) =>
                slider
                    .setLimits(5, 240, 5)
                    .setDynamicTooltip()
                    .setValue(this.plugin.settings.dailyGoalMinutes)
                    .onChange(async (value) => {
                        this.plugin.settings.dailyGoalMinutes = value;
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                    })
            );

        containerEl.createEl('h3', { text: 'Reset' });

        new Setting(containerEl)
            .setName('Reset to Defaults')
            .setDesc('Reset all settings to their default values')
            .addButton((button) =>
                button
                    .setButtonText('Reset All Settings')
                    .setCta()
                    .onClick(async () => {
                        this.plugin.settings = Object.assign({}, DEFAULT_SETTINGS);
                        await this.plugin.saveSettings();
                        this.plugin.refreshReaderModeIfActive();
                        this.display();
                        new Notice('All settings have been reset to defaults');
                    })
            );
    }
}
