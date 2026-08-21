/**
 * Minimal inline SVG icon set for the editor UI - no icon library required.
 */

interface IconProps {
    size?: number;
}

const svgProps = (size: number) => ({
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const
});

export const BrushIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.07" />
        <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
);

export const EraserIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M7 21h10" />
        <path d="M5.5 13.5L14 5a2.12 2.12 0 0 1 3 0l3 3a2.12 2.12 0 0 1 0 3l-8.5 8.5a2 2 0 0 1-3 0l-3-3a2 2 0 0 1 0-3z" />
        <path d="M10 8l6 6" />
    </svg>
);

export const PickerIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M2 22l1-1h3l9-9" />
        <path d="M3 21v-3l9-9" />
        <path d="M15 6l3-3a2.12 2.12 0 0 1 3 3l-3 3" />
        <path d="M14 5l5 5" />
    </svg>
);

export const CubeIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="M3.3 7L12 12l8.7-5" />
        <path d="M12 22V12" />
    </svg>
);

export const BlobIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M12 3c4.5 0 9 3.6 9 8.1 0 4.6-3.6 9.9-9 9.9s-9-5.3-9-9.9C3 6.6 7.5 3 12 3z" />
        <path d="M8.5 10.5a1 1 0 1 0 0-.01" />
    </svg>
);

export const UndoIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M3 7v6h6" />
        <path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13" />
    </svg>
);

export const RedoIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M21 7v6h-6" />
        <path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13" />
    </svg>
);

export const SaveIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M7 10l5 5 5-5" />
        <path d="M12 15V3" />
    </svg>
);

export const LoadIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <path d="M17 8l-5-5-5 5" />
        <path d="M12 3v12" />
    </svg>
);

export const NewIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
        <path d="M14 2v6h6" />
    </svg>
);

export const SparkleIcon = ({ size = 18 }: IconProps) => (
    <svg {...svgProps(size)}>
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
        <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15z" />
    </svg>
);
