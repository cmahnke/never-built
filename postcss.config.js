import { purgeCSSPlugin } from '@fullhuman/postcss-purgecss';
import { cssnanoPlugin } from 'cssnano';

module.exports = {
  plugins: [
    purgecss({
      content: ['./docs/**/*.js', './docs/**/*.html'],
      css: ['./docs/css/*.css']
    }),
    rcssnanoPlugin({
        preset: 'default',
    }),
  ],
};
