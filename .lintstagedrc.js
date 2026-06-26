export default {
  "frontend/**/*.{js,jsx,ts,tsx}": [
    "bash -c 'cd frontend && ./node_modules/.bin/eslint --fix \"$@\"' --",
    "prettier --write",
  ],
  "**/*.{json,css,md}": ["prettier --write"],
  "*.{js,ts,mjs,cjs}": ["prettier --write"],
};
