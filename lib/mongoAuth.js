const { BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const { proto } = require('@whiskeysockets/baileys/WAProto');

const useMongoDBAuthState = async (collection) => {
    const writeData = async (data, id) => {
        try {
            const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            const update = { $set: { ...informationToStore } };
            await collection.updateOne({ _id: id }, update, { upsert: true });
        } catch (error) {
            console.error('Gagal menyimpan sesi ke MongoDB:', error);
        }
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data) {
                // Remove the MongoDB specific _id before reviving
                delete data._id;
                const parsedData = JSON.parse(JSON.stringify(data), BufferJSON.reviver);
                return parsedData;
            }
            return null;
        } catch (error) {
            console.error('Gagal membaca sesi dari MongoDB:', error);
            return null;
        }
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {
            console.error('Gagal menghapus sesi dari MongoDB:', error);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async id => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            if (value) {
                                tasks.push(writeData(value, key));
                            } else {
                                tasks.push(removeData(key));
                            }
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => {
            return writeData(creds, 'creds');
        }
    };
};

module.exports = { useMongoDBAuthState };
