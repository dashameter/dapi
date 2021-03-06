const {
  startDapi,
} = require('@dashevo/dp-services-ctl');

const {
  PrivateKey,
  PublicKey,
  Transaction,
} = require('@dashevo/dashcore-lib');

const GrpcErrorCodes = require('@dashevo/grpc-common/lib/server/error/GrpcErrorCodes');

const DashPlatformProtocol = require('@dashevo/dpp');

const getDataContractFixture = require('@dashevo/dpp/lib/test/fixtures/getDataContractFixture');
const { convertSatoshiToCredits } = require(
  '@dashevo/dpp/lib/identity/creditsConverter',
);

const wait = require('../../../../../lib/utils/wait');

describe('getDocumentsHandlerFactory', function main() {
  this.timeout(90000);

  let removeDapi;
  let dpp;
  let dapiClient;
  let identity;
  let dataContract;
  let identityPrivateKey;
  let accumulatedFee;
  let publicKeyId;

  before(async () => {
    const {
      dapiCore,
      dashCore,
      remove,
    } = await startDapi();

    removeDapi = remove;

    const coreAPI = dashCore.getApi();
    dapiClient = dapiCore.getApi();

    dpp = new DashPlatformProtocol({
      dataProvider: {},
    });

    const { result: addressString } = await coreAPI.getNewAddress();
    const { result: privateKeyString } = await coreAPI.dumpPrivKey(addressString);

    const privateKey = new PrivateKey(privateKeyString);
    const publicKey = new PublicKey({
      ...privateKey.toPublicKey().toObject(),
      compressed: true,
    });
    const pubKeyBase = publicKey.toBuffer()
      .toString('base64');
    publicKeyId = 0;

    identityPrivateKey = privateKey;

    // eslint-disable-next-line no-underscore-dangle
    const publicKeyHash = PublicKey.fromBuffer(Buffer.from(pubKeyBase, 'base64'))
      ._getID();

    await coreAPI.generateToAddress(500, addressString);

    const { result: unspent } = await coreAPI.listUnspent();
    const inputs = unspent.filter(input => input.address === addressString);

    const transaction = new Transaction();

    transaction.from(inputs.slice(-1)[0])
      .addBurnOutput(2, publicKeyHash)
      .change(addressString)
      .fee(668)
      .sign(privateKey);

    await coreAPI.sendrawtransaction(transaction.serialize());

    await coreAPI.generateToAddress(1, addressString);

    await wait(2000); // wait a couple of seconds for tx to be confirmed

    const outPoint = transaction.getOutPointBuffer(0);

    identity = dpp.identity.create(
      outPoint,
      [publicKey],
    );

    accumulatedFee = 0;

    const identityCreateTransition = dpp.identity.createIdentityCreateTransition(identity);
    identityCreateTransition.signByPrivateKey(privateKey);

    accumulatedFee += identityCreateTransition.calculateFee();

    await dapiClient.platform.broadcastStateTransition(identityCreateTransition.serialize());

    dataContract = getDataContractFixture(identity.getId());

    const dataContractStateTransition = dpp.dataContract.createStateTransition(dataContract);
    dataContractStateTransition.sign(identity.getPublicKeyById(publicKeyId), identityPrivateKey);

    accumulatedFee += dataContractStateTransition.calculateFee();

    await dapiClient.platform.broadcastStateTransition(dataContractStateTransition.serialize());
  });

  after(async () => {
    await removeDapi();
  });

  it('should fetch created documents array', async () => {
    const document = dpp.document.create(
      dataContract, identity.getId(), 'niceDocument', {
        name: 'someName',
      },
    );

    const documentTransition = dpp.document.createStateTransition({
      create: [document],
    });
    documentTransition.sign(identity.getPublicKeyById(publicKeyId), identityPrivateKey);

    accumulatedFee += documentTransition.calculateFee();

    await dapiClient.platform.broadcastStateTransition(documentTransition.serialize());

    const [documentBuffer] = await dapiClient.platform.getDocuments(dataContract.getId(), 'niceDocument', {});

    const receivedDocument = await dpp.document.createFromSerialized(
      documentBuffer, { skipValidation: true },
    );

    expect(document.toJSON()).to.deep.equal(receivedDocument.toJSON());
  });

  it('should fail to create more documents if not having enough credits', async () => {
    const document = dpp.document.create(
      dataContract, identity.getId(), 'niceDocument', {
        name: 'someVeryLongOtherNameForTheDocument'.repeat(256),
      },
    );

    const documentTransition = dpp.document.createStateTransition({
      create: [document],
    });
    documentTransition.sign(identity.getPublicKeyById(publicKeyId), identityPrivateKey);

    try {
      await dapiClient.platform.broadcastStateTransition(documentTransition.serialize());
      expect.fail('Error was not thrown');
    } catch (e) {
      expect(e.code).to.equal(GrpcErrorCodes.FAILED_PRECONDITION);
      expect(e.details).to.equal('Failed precondition: Not enough credits');

      const initialBalance = convertSatoshiToCredits(2);
      expect(e.metadata.get('balance')[0]).to.equal(
        (initialBalance - accumulatedFee).toString(),
      );
    }
  });
});
