// Unit-test calendar only. Production uses the pinned date-holidays package.
export default class Holidays {setLanguages(){} getHolidays(year){return [['01-01','신정'],['03-01','삼일절'],['05-05','어린이날'],['06-06','현충일'],['08-15','광복절'],['10-03','개천절'],['10-09','한글날'],['12-25','성탄절']].map(([d,name])=>({date:`${year}-${d}`,name,type:'public'}));}}
