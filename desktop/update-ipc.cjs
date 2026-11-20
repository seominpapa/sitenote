const { ownedPage } = require('./runtime.cjs');

function registerUpdateIpc(ipc, getContents, currentVersion, updater, openAsset) {
  const operations = {
    version: () => currentVersion,
    'update-check': () => updater.check(),
    'update-download': () => updater.download(),
    'update-open': async () => {
      const asset = await updater.verifiedFile();
      await openAsset(asset.path);
      return true;
    },
  };
  for (const [name, run] of Object.entries(operations)) {
    ipc.handle('sitenote:' + name, (event, ...args) => {
      const contents = getContents();
      if (!contents || event.sender !== contents || !event.senderFrame ||
          event.senderFrame !== contents.mainFrame || !ownedPage(event.senderFrame.url) || args.length) {
        throw new Error('허용되지 않은 업데이트 요청입니다.');
      }
      return run();
    });
  }
}

module.exports = { registerUpdateIpc };
