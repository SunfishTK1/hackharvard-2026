import React from "react";

export type ViewMode = "agentic" | "classic";

interface ProdModeToggleProps {
  mode: ViewMode;
  onChange: (nextMode: ViewMode) => void;
}

/**
 * Top-right mode switch styled after the Prod logo mark:
 * a high-contrast monochrome emblem + pill switch that flips between
 * "Agentic" and "Classic" modes.
 */
export const ProdModeToggle: React.FC<ProdModeToggleProps> = ({ mode, onChange }) => {
  const isAgentic = mode === "agentic";

  const handleToggle = () => {
    onChange(isAgentic ? "classic" : "agentic");
  };

  return (
    <div className="prod-toggle-wrapper">
      <button
        type="button"
        role="switch"
        aria-checked={isAgentic}
        aria-label={`Switch mode (currently ${isAgentic ? "Agentic" : "Classic"})`}
        className={`prod-logo-toggle ${isAgentic ? "is-agentic" : "is-classic"}`}
        onClick={handleToggle}
      >
        {/* Prod Logo Emblem: Sliding Monochrome Mark */}
        <span className="prod-logo-track" aria-hidden="true">
          <span className="prod-logo-thumb">
            <svg
              className="prod-logo-svg"
              viewBox="0 0 36 36"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              {/* Outer geometric P / capsule frame */}
              <rect
                x="3"
                y="3"
                width="30"
                height="30"
                rx="9"
                stroke="currentColor"
                strokeWidth="3"
              />
              {/* Bold Prod 'P' stem + loop */}
              <path
                d="M12 26V10H19.5C22.5376 10 25 12.4624 25 15.5C25 18.5376 22.5376 21 19.5 21H12"
                stroke="currentColor"
                strokeWidth="3.2"
                strokeLinecap="square"
                strokeLinejoin="miter"
              />
              {/* Agentic spark / node dot at bottom-right of the P */}
              <circle
                className="prod-logo-node"
                cx="23.5"
                cy="24.5"
                r="2.5"
                fill="currentColor"
              />
            </svg>
          </span>
        </span>

        {/* Brand + Mode Labels */}
        <span className="prod-toggle-copy">
          <span className="prod-brand-label">PROD</span>
          <span className="prod-mode-pills">
            <span className={`prod-mode-option ${isAgentic ? "active" : ""}`}>
              Agentic
            </span>
            <span className="prod-mode-divider">/</span>
            <span className={`prod-mode-option ${!isAgentic ? "active" : ""}`}>
              Classic
            </span>
          </span>
        </span>
      </button>
    </div>
  );
};
