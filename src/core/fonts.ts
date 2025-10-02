export interface FontChoice {
    value: string;
    label: string;
}

export const FONT_CHOICES: FontChoice[] = [
    { value: "'Athelas', 'Georgia', 'Times New Roman', serif", label: "Athelas" },
    { value: "'Avenir Next', 'Helvetica Neue', 'Helvetica', 'Arial', sans-serif", label: "Avenir Next" },
    { value: "'Charter', 'Georgia', 'Times New Roman', serif", label: "Charter" },
    { value: "'Georgia', 'Times New Roman', serif", label: "Georgia" },
    { value: "'Iowan Old Style', 'Palatino', 'Times New Roman', serif", label: "Iowan" },
    { value: "'Palatino', 'Palatino Linotype', 'Book Antiqua', serif", label: "Palatino" }
];

export const DEFAULT_FONT_FAMILY = FONT_CHOICES[0].value;

const LEGACY_MAPPING: Record<string, string> = {
    'inherit': DEFAULT_FONT_FAMILY,
    'original': DEFAULT_FONT_FAMILY,
    'serif': FONT_CHOICES[2].value,
    'sans-serif': FONT_CHOICES[1].value,
    'sans serif': FONT_CHOICES[1].value,
    'monospace': DEFAULT_FONT_FAMILY,
    'system': DEFAULT_FONT_FAMILY,
    'system default': DEFAULT_FONT_FAMILY
};

export function normalizeFontFamily(value: string | null | undefined): string {
    if (!value) {
        return DEFAULT_FONT_FAMILY;
    }

    const trimmed = value.trim();
    if (!trimmed) {
        return DEFAULT_FONT_FAMILY;
    }

    if (FONT_CHOICES.some((option) => option.value === trimmed)) {
        return trimmed;
    }

    const lower = trimmed.toLowerCase();

    const labelMatch = FONT_CHOICES.find((option) => option.label.toLowerCase() === lower);
    if (labelMatch) {
        return labelMatch.value;
    }

    const legacy = LEGACY_MAPPING[lower];
    if (legacy) {
        return legacy;
    }

    for (const option of FONT_CHOICES) {
        if (lower.includes(option.label.toLowerCase())) {
            return option.value;
        }
    }

    return DEFAULT_FONT_FAMILY;
}
