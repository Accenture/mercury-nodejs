import { EventEnvelope } from '../src/models/event-envelope';

describe('event envelope functional tests', () => {
      
    it('can trim floating point number to 3 decimal points', () => {
        const target = "hello.world";
        const payload = "hello";
        const roundTrip = 3.2341002;
        const event = new EventEnvelope().setTo(target).setBody(payload);
        event.setFrom("unit.test").setCorrelationId("123");
        event.setTraceId("100").setTracePath("GET /api/hello/world");
        event.setRoundTrip(roundTrip);
        const map = event.toMap();
        expect(map['round_trip']).toBe(3.234);
    });     
    
    it('can convert event envelope to a map and vice versa', () => {
        const target = "hello.world";
        const payload = "hello";
        const replyTo = "my.callback";
        const timeout = "1000";
        const execTime = 3.123;
        const roundTrip = 3.234;
        const before = new EventEnvelope().setTo(target).setBody(payload);
        before.setFrom("unit.test").setCorrelationId("123");
        before.setTraceId("100").setTracePath("GET /api/hello/world");
        before.addTag("rpc", timeout);
        before.setException(true);
        before.setReplyTo(replyTo);
        before.setExecTime(execTime);
        before.setRoundTrip(roundTrip);
        const map = before.toMap();
        const after = new EventEnvelope(map);
        expect(after).toEqual(before);
        after.removeTag("rpc");
        expect(after.getTag("rpc")).toBeNull();
        after.setException(false);
        expect(after.isException()).toBeFalsy();
        expect(after.getRoundTrip()).toBe(roundTrip);
    });  

    it('can convert event envelope to byte array and vice versa', () => {
        const target = "hello.world";
        const payload = "hello";
        const replyTo = "my.callback";
        const timeout = "1000";
        const execTime = 3.123;
        const roundTrip = 3.234;
        const before = new EventEnvelope().setTo(target).setBody(payload);
        before.setId("abcde");
        before.setFrom("unit.test").setCorrelationId("123");
        before.setTraceId("100").setTracePath("GET /api/hello/world");
        before.addTag("rpc", timeout);
        before.setException(true);
        before.setReplyTo(replyTo);
        before.setExecTime(execTime);
        before.setRoundTrip(roundTrip);
        const binaryData = before.toBytes();
        const after = new EventEnvelope(binaryData);
        expect(after).toEqual(before);
        after.removeTag("rpc");
        expect(after.getTag("rpc")).toBeNull();
        after.setException(false);
        expect(after.isException()).toBeFalsy();
        expect(after.getRoundTrip()).toBe(roundTrip);
        expect(after.getCorrelationId()).toBe("123");
        expect(after.getId()).toBe("abcde");
    });  

});