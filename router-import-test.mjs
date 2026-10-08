const m = await import('./index.js');
console.log('IMPORT_OK apply=' + typeof m.apply + ' inject=' + JSON.stringify(m.inject));
