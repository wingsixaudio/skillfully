# The Companion module used by the tests

`skillfully-test-lamp-1.0.0.tgz` is a real Bitfocus Companion module package: the same kind of file Companion
installs. It was built from `lamp-src/` with Bitfocus's own build tool, so it contains their module library
(`@companion-module/base`, MIT, license text inside the package) exactly as a module author's build would.

The tests drop it into a hub and have it drive a pretend lamp. It is not for real use.

To rebuild it after changing `lamp-src/` (needs Node 22 and npm):

```
cd tests/fixtures/companion/lamp-src
npm install --ignore-scripts
npx companion-module-build
mv skillfully-test-lamp-1.0.0.tgz ..
rm -rf node_modules pkg package-lock.json
```
