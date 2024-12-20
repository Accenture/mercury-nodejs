import { Logger } from '../src/util/logger.js';
import { TemplateLoader } from '../src/util/template-loader.js';

const log = Logger.getInstance();

describe('template tests', () => {   
      
    it('can read a template from resources folder', async () => {
        const loader = new TemplateLoader();
        const template = loader.getTemplate('preload.template');
        expect(template).toBeTruthy();
        expect(template.includes('${import-statements}')).toBe(true);
        expect(template.includes('${service-list}')).toBe(true);
        log.info(`Template contains ${template.length} characters`);
    });     

});        