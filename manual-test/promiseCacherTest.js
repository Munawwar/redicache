const promiseCacher = require('../src/promiseCacher');

async function expensiveTask() {
  console.log('expensiveTask executing... only once...');
  return new Promise(
    (resolve) => setTimeout(() => resolve({ answerToLifeAndEverything: 42 }), 3000),
  );
}

(async () => {
  const task = promiseCacher(expensiveTask);

  const results = await Promise.all([
    task('key'),
    task('key'),
    task('key'),
  ]);

  console.log('results', results);
  console.log('are objects cloned?', results[0] !== results[1]); // should be true. To make sure the object is cloned
})();
