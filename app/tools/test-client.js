const { Client } = require('ssh2');
const c = new Client();
c.on('ready', () => {
  c.sftp((err, sftp) => {
    if (err) { console.error('sftp err', err); process.exit(1); }
    sftp.readdir('/testroot', (e, list) => {
      console.log('readdir err:', e && e.message);
      console.log('count:', list ? list.length : 0);
      console.log((list || []).map((x) => x.filename + ' ' + x.attrs.mode.toString(8)).join('\n'));
      c.end();
    });
  });
});
c.on('error', (e) => console.error('conn err', e.message))
 .connect({ host: '127.0.0.1', port: 2222, username: 'test', password: 'test' });
