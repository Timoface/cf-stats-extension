# Third-party notices

## Chart.js

- Version: 4.4.7 (vendored as `src/vendor/chart.umd.min.js`)
- Project: https://www.chartjs.org/
- License: MIT
- Copyright: Chart.js Contributors

The unmodified UMD build is bundled locally so that the extension does not load
remote code, as required by Manifest V3 and Firefox extension policies.

## AtCoder Problems

- Project: https://kenkoooo.com/atcoder/ (Kenkoooo)
- Data used: public problem list and difficulty models
- License of the open-source project: MIT

The extension fetches the public JSON resources at build/runtime and caches them
locally. AtCoder problem statements and other AtCoder content remain the property
of AtCoder and their respective authors. This extension is unofficial and is not
affiliated with AtCoder.

## Codeforces

- API documentation: https://codeforces.com/apiHelp
- Data used: public problem archive, user submissions, problem ratings and tags

Codeforces data remains the property of Codeforces and the respective authors.
This extension is unofficial and is not affiliated with Codeforces.

## Runtime dependencies

None beyond the browser extension APIs and the bundled Chart.js file. The build
and test scripts use only the Node.js standard library.
