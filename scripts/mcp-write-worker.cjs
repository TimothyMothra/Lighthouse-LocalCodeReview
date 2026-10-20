const { updateReviewFile } = require('../out/reviewPersistence');
const { addReply } = require('../out/reviewCore');
updateReviewFile(process.argv[2], async (review) => {
	process.send('locked');
	await new Promise((resolve) => process.once('message', resolve));
	review.reviewedFiles = [];
	review.reviewedFileSnapshots = {};
	addReply(review, 't-1', undefined, 'Human follow-up', { kind: 'human', name: 'reviewer' });
}).then(() => process.disconnect(), (error) => { process.stderr.write(error.message); process.exitCode = 1; process.disconnect(); });
