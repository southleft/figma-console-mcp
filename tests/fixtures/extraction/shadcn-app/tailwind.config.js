/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: "#3b82f6",
        "brand-dark": "#1d4ed8",
      },
      spacing: {
        "18": "4.5rem",
      },
      borderRadius: {
        card: "12px",
      },
    },
  },
  plugins: [],
};
