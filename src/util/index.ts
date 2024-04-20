import { Request, Response } from "express";
import moment, { Moment } from "moment";
import { ObjectId } from "mongodb";
import * as Mongo from "../modules/mongo";
import { getCollection, parseId } from "../modules/mongo";
import LRU from "lru-cache";
import { documentObject } from "../modules/mongo/baseTypes";
import { dispatchDelete, OperationType } from "../modules/socket";
import { FriendLevel, friendReadCollections, getFriendLevel, isFriend, isTrustedFriend } from "../security";
import { parseForAllowedReadValues } from "../security/readRules";
import { FIELD_MIGRATION_VERSION, doesUserHaveVersion } from "../api/v1/user/updates/updateUser";

export function transformResultForClientRead(value: documentObject, requestorUid: string) {
	parseForAllowedReadValues(value, requestorUid);

	const { _id, ...other } = value;
	return {
		exists: true,
		id: _id,
		content: other,
	};
}

const isFriendsLRU = new LRU<string, boolean>({ max: 10000, ttl: 1000 * 5 });
const friendBucketsLRU = new LRU<string, (ObjectId)[]>({ max: 10000, ttl: 1000 * 5 });

export const getDocumentAccess = async (requestor: string, document: documentObject, collection: string): Promise<{ access: boolean; statusCode: number; message: string }> => {
	if (document.uid == requestor) {
		return { access: true, statusCode: 200, message: "" }
	}

	const migratedUser = await doesUserHaveVersion(document.uid, FIELD_MIGRATION_VERSION)
	if (migratedUser)
	{
		if (collection === "friends")
		{
			if ( document.frienduid == requestor)
			{
				return { access: true, statusCode: 200, message: "" }
			}

			return { access: false, statusCode: 403, message: "Access to document has been rejected." }
		}

		if (collection === "users")
		{
			const friendsString = `${document.uid}${requestor}`
			const isFriends = isFriendsLRU.get(friendsString)
			if (isFriends === true)
			{
				return { access: true, statusCode: 200, message: "" }
			}
			else if (isFriends === false)
			{
				return { access: false, statusCode: 403, message: "Access to document has been rejected." }
			}

			const friendDoc = await getCollection("friends").findOne({uid: document.uid, frienduid: requestor})
			
			if (friendDoc)
			{
				isFriendsLRU.set(friendsString, true)
				return { access: true, statusCode: 200, message: "" }
			}
			else 
			{
				isFriendsLRU.set(friendsString, false)
				return { access: false, statusCode: 403, message: "Access to document has been rejected." }
			}
		}

		if (!document.buckets || document.buckets.length === 0)
		{
			return { access: false, statusCode: 403, message: "Access to document has been rejected." }
		}

		const friendBucketsKey = `${document.uid}${requestor}`

		let cachedBuckets = friendBucketsLRU.get(friendBucketsKey)
		if (cachedBuckets === undefined)
		{
			const friendDoc = await Mongo.getCollection("friends").findOne({ uid: document.uid, frienduid: requestor })
			cachedBuckets = friendDoc.buckets

			if (!cachedBuckets)
			{
				cachedBuckets = []
			}

			friendBucketsLRU.set(friendBucketsKey, cachedBuckets)
		}

		const intersects = document.buckets.findIndex((value: ObjectId) => cachedBuckets!.findIndex((cachedId: ObjectId) =>	value.equals(cachedId)) != -1) != -1

		if (intersects !== true)
		{
			return { access: false, statusCode: 403, message: "Access to document has been rejected." };
		}

		return { access: true, statusCode: 200, message: "" };
	}
	else 
	{
		if (document.private && document.preventTrusted) {
			return { access: false, statusCode: 403, message: "Access to document has been rejected." };
		} else {
			const friendLevel: FriendLevel = await getFriendLevel(document.uid, requestor);
			const isaFriend = isFriend(friendLevel);
			if (!isaFriend) {
				if (collection === "users" && !!(friendLevel == FriendLevel.Pending)) {
					// Only send relevant data
					document = { uid: document.uid, _id: document._id, username: document.username, message: document.message };
	
					return { access: true, statusCode: 200, message: "" };
				}
				return { access: false, statusCode: 403, message: "Access to document has been rejected." };
			} else {
				if (document.private) {
					const trustedFriend: boolean = await isTrustedFriend(friendLevel);
					if (trustedFriend) {
						return { access: document.preventTrusted !== true, statusCode: 200, message: "" };
					} else {
						return { access: false, statusCode: 403, message: "Access to document has been rejected." };
					}
				}
				return { access: true, statusCode: 200, message: "" };
			}
		}
	} 
};

export const sendDocuments = async (req: Request, res: Response, collection: string, documents: documentObject[]) => {
	const returnDocuments: any[] = [];

	for (let i = 0; i < documents.length; ++i) {
		const access = await getDocumentAccess(res.locals.uid, documents[i], collection);
		if (access.access === true) {
			returnDocuments.push(transformResultForClientRead(documents[i], res.locals.uid));
		}
	}

	res.status(200).send(returnDocuments);
};

export const sendDocument = async (req: Request, res: Response, collection: string, document: documentObject) => {
	if (!document) {
		res.status(404).send();
		return;
	}

	const access = await getDocumentAccess(res.locals.uid, document, collection);
	if (access.access === true) {
		res.status(200).send(transformResultForClientRead(document, res.locals.uid));
		return;
	}
	res.status(access.statusCode).send(access.message);
};

export const fetchSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const document = await Mongo.getCollection(collection).findOne({ _id: parseId(req.params.id), uid: req.params.system ?? res.locals.uid });
	sendDocument(req, res, collection, document);
};

export const deleteSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const result = await Mongo.getCollection(collection).deleteOne({
		_id: parseId(req.params.id),
		uid: res.locals.uid,
		$or: [{ lastOperationTime: null }, { lastOperationTime: { $lte: res.locals.operationTime } }],
	});
	if (result.deletedCount && result.deletedCount > 0) {
		dispatchDelete({
			operationType: OperationType.Delete,
			uid: res.locals.uid,
			documentId: req.params.id,
			collection: collection,
		});
		res.status(200).send();
	} else {
		res.status(404).send();
	}
};

export type forEachDocument = (document: any) => Promise<void>;

export const fetchCollection = async (req: Request, res: Response, collection: string, findQuery: { [key: string]: any }, forEach?: forEachDocument) => {

	findQuery.uid = req.params.system ?? res.locals.uid;

	// Pre-flight check access to collection of others
	if (findQuery.uid != res.locals.uid) {
		if (friendReadCollections.indexOf(collection) < 0) {
			res.status(401).send()
			return
		}
	}

	const query = Mongo.getCollection(collection).find(findQuery);

	if (req.query.limit) {
		query.limit(Number(req.query.limit));
	}

	if (req.query.sortBy && req.query.sortOrder) {
		const sortQuery: any = {};
		const sortString: string = req.query.sortBy.toString();
		sortQuery[sortString] = Number(req.query.sortOrder);
		query.sort(sortQuery);
	} else {
		query.sort({ name: 1 });
	}

	if (req.query.start) {
		query.skip(Number(req.query.start));
	}

	const documents = await query.toArray();

	if (forEach) {
		for (let i = 0; i < documents.length; ++i) {
			await forEach(documents[i]);
		}
	}

	sendDocuments(req, res, collection, documents);
};

export const addSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const dataObj: documentObject = req.body;
	dataObj._id = parseId(res.locals.useId) ?? new ObjectId();
	dataObj.uid = res.locals.uid;
	dataObj.lastOperationTime = res.locals.operationTime;
	const result = await Mongo.getCollection(collection)
		.insertOne(dataObj)
		.catch(() => {
			return {
				insertedId: "",
				acknowledged: false,
			};
		});

	if (result.insertedId.toString().length <= 0) {
		res.status(500).send("Server processed your request, however was unable to enter a document into the database");
		return;
	}

	res.status(200).send(result.insertedId);
};

export const updateSimpleDocument = async (req: Request, res: Response, collection: string) => {
	const dataObj: documentObject = req.body;
	dataObj.uid = res.locals.uid;
	dataObj.lastOperationTime = res.locals.operationTime;
	await Mongo.getCollection(collection).updateOne(
		{
			_id: parseId(req.params.id),
			uid: res.locals.uid,
			$or: [{ lastOperationTime: null }, { lastOperationTime: { $lte: res.locals.operationTime } }],
		},
		{ $set: dataObj }
	);

	res.status(200).send();
};

export const isMember = async (uid: string, id: string) => {
	const member = await Mongo.getCollection("members").findOne({ uid, _id: parseId(id) });
	return !!member;
};

export const isCustomFront = async (uid: string, id: string) => {
	const cf = await Mongo.getCollection("frontStatuses").findOne({ uid, _id: parseId(id) });
	return !!cf;
};

export const isMemberOrCustomFront = async (uid: string, id: string) => {
	return (await isMember(uid, id)) || (await isCustomFront(uid, id));
};

export const getAPIUrl = (extension: string) => {
	if (process.env.LOCAL === "true") {
		return `http://${getAPIUrlBase()}/` + extension;
	}

	return `https://${getAPIUrlBase()}/` + extension;
};

export const getAPIUrlBase = () => {
	if (process.env.LOCAL === "true") {
		return "localhost:3000";
	}

	if (process.env.PRETESTING === "true") {
		return "devapi.apparyllis.com";
	} else {
		return "api.apparyllis.com";
	}
};

export const getStartOfDay = (): Moment => {
	const today = moment();
	return today.startOf("day");
};

export const isPrimaryInstace = () => {
	return process.env.NODE_APP_INSTANCE === '0';
}

export const convertListToIds = async (uid: string, collection: string, listOfIds: string[], ) : Promise<any[]> =>
{
	const ids : any[] = []

    listOfIds.forEach((id : string) => 
    {
        ids.push(parseId(id))
    })

	const foundDocuments = await getCollection(collection).find({ uid: uid, _id: { $in: ids }}).toArray()

	const resultingIds : any[] = []

	foundDocuments.forEach((document) => { resultingIds.push(document._id) })

	return resultingIds
}