import { purgeCSSPlugin } from '@fullhuman/postcss-purgecss';
import { cssnanoPlugin } from 'cssnano';

const purgecss = purgeCSSPlugin({
  content: ["./hugo_stats.json"],
  defaultExtractor: (content) => {
    const els = JSON.parse(content).htmlElements;
    return [...(els.tags || []), ...(els.classes || []), ...(els.ids || [])];
  },
  safelist: [],
});

module.exports = {
  plugins: [
    ...(process.env.HUGO_ENVIRONMENT === "production" ? [purgecss] : []),
    rcssnanoPlugin({
        preset: 'default',
    }),
  ],
};
